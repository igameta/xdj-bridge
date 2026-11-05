#!/usr/bin/env python3
"""Read one known /D/ OneLibrary database into a new local temporary cache.

Explicit execution only. Maximum 1 MiB, 4096-byte READs, no retries, 120s total.
No remote write procedures are implemented. Output contains only size and hash.
"""
import argparse
import hashlib
import importlib.util
import ipaddress
import json
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('az_nfs_headers', Path(__file__).with_name('probe-az-nfs-headers.py'))
xdr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xdr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interface', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--mount-port', required=True, type=int)
    parser.add_argument('--nfs-port', required=True, type=int)
    parser.add_argument('--output', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    destination = Path(args.output).resolve()
    if not destination.is_relative_to(Path('/private/tmp')) or destination.exists():
        parser.error('Output must be a new file inside /private/tmp')
    interface = subprocess.run(['ifconfig', args.interface], check=True, capture_output=True, text=True).stdout
    valid = False
    for address, mask in re.findall(r'\binet (\d+\.\d+\.\d+\.\d+) netmask (\S+)', interface):
        if address == args.source:
            mask = str(ipaddress.IPv4Address(int(mask, 16))) if mask.startswith('0x') else mask
            network = ipaddress.IPv4Interface(f'{address}/{mask}').network
            target = ipaddress.IPv4Address(args.target)
            valid = target in network and target not in (network.network_address, network.broadcast_address, ipaddress.IPv4Address(args.source))
    if not valid or not all(1 <= port <= 65535 for port in [args.mount_port, args.nfs_port]):
        parser.error('Invalid source/subnet or discovered ports')
    if not args.execute:
        print(json.dumps({'execute': False, 'remotePath': '/D/PIONEER/rekordbox/exportLibrary.db', 'maxBytes': 1048576}))
        return
    xid = 0x415a2000
    started = time.monotonic()
    deadline = started + 120
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(2)
        if sys.platform == 'darwin':
            sock.setsockopt(socket.IPPROTO_IP, 25, socket.if_nametoindex(args.interface))
        sock.bind((args.source, 0))

        def call(program, version, procedure, port, data=b''):
            nonlocal xid
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('120-second read limit exceeded')
            sock.settimeout(min(2, remaining))
            xid += 1
            auth = struct.pack('!5I', 0, 0, 0, 0, 0)
            request = struct.pack('!6I', xid, 0, 2, program, version, procedure)
            request += struct.pack('!2I', 1, len(auth)) + auth + struct.pack('!2I', 0, 0) + data
            sock.connect((args.target, port))
            sock.send(request)
            return xdr.rpc_result(sock.recv(16384), xid)

        exports = xdr.exports_from(call(100005, 1, 5, args.mount_port))
        if not any(export['path'] == '/D/' for export in exports):
            raise ValueError('Previously observed /D/ is no longer exported')
        body = call(100005, 1, 1, args.mount_port, xdr.text('/D/'))
        if xdr.uint(body) != 0 or len(body) < 36:
            raise ValueError('Mount handle unavailable')
        handle = body[4:36]
        for name in ['PIONEER', 'rekordbox', 'exportLibrary.db']:
            body = call(100003, 2, 4, args.nfs_port, handle + xdr.text(name))
            if xdr.uint(body) != 0 or len(body) < 104:
                raise ValueError(f'Known database lookup failed at {name}')
            handle = body[4:36]
        size = xdr.uint(body, 56)
        if not 0 < size <= 1048576 or xdr.uint(body, 36) != 1:
            raise ValueError('Database is not a regular file within the 1 MiB bound')
        chunks = []
        offset = 0
        while offset < size:
            count = min(4096, size - offset)
            body = call(100003, 2, 6, args.nfs_port, handle + struct.pack('!3I', offset, count, 0))
            if xdr.uint(body) != 0 or len(body) < 76:
                raise ValueError('NFS READ failed')
            data, _ = xdr.read_opaque(body, 72)
            if not 0 < len(data) <= count or xdr.uint(body, 24) != size:
                raise ValueError('Empty, oversize or changed database READ')
            chunks.append(data)
            offset += len(data)
    data = b''.join(chunks)
    if len(data) != size:
        raise ValueError('Database size changed during the bounded read')
    with destination.open('xb') as cache:
        cache.write(data)
    print(json.dumps({'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}))


if __name__ == '__main__':
    main()
