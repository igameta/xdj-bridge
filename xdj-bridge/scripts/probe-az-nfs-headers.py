#!/usr/bin/env python3
"""Inspect announced NFS exports and at most 4096 bytes of known DB headers.

No OS mount, directory crawl, file creation, rename, delete or write RPC exists
here. Dry-run is default; parent must supply the ports returned by GETPORT.
"""
import argparse
import ipaddress
import json
import re
import socket
import struct
import subprocess
import sys
import time


def uint(data, offset=0):
    if offset < 0 or offset + 4 > len(data):
        raise ValueError('Truncated XDR integer')
    return struct.unpack_from('!I', data, offset)[0]


def opaque(value):
    return struct.pack('!I', len(value)) + value + bytes((-len(value)) % 4)


def text(value):
    return opaque(value.encode('utf-16le'))


def read_opaque(data, offset):
    size = uint(data, offset)
    if size > 8192 or offset + 4 + ((size + 3) // 4) * 4 > len(data):
        raise ValueError('Oversize or truncated XDR string')
    return data[offset + 4:offset + 4 + size], offset + 4 + ((size + 3) // 4) * 4


def rpc_result(data, xid):
    if len(data) < 24 or (uint(data), uint(data, 4), uint(data, 8)) != (xid, 1, 0):
        raise ValueError('Unexpected or rejected RPC reply')
    offset = 20 + ((uint(data, 16) + 3) // 4) * 4
    if uint(data, offset) != 0:
        raise ValueError('RPC call unsuccessful')
    return data[offset + 4:]


def exports_from(data):
    values = []
    offset = 0
    while uint(data, offset):
        offset += 4
        if len(values) >= 16:
            raise ValueError('Too many exports')
        raw, offset = read_opaque(data, offset)
        path = raw.decode('utf-16le')
        groups = []
        while uint(data, offset):
            offset += 4
            if len(groups) >= 16:
                raise ValueError('Too many export groups')
            raw, offset = read_opaque(data, offset)
            groups.append(raw.decode('utf-8', 'replace'))
        offset += 4
        values.append({'path': path, 'groups': groups})
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interface', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--mount-port', required=True, type=int)
    parser.add_argument('--nfs-port', required=True, type=int)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--read-header', action='store_true')
    args = parser.parse_args()
    interface = subprocess.run(['ifconfig', args.interface], capture_output=True, text=True, check=True).stdout
    found = False
    for address, mask in re.findall(r'\binet (\d+\.\d+\.\d+\.\d+) netmask (\S+)', interface):
        if address == args.source:
            mask = str(ipaddress.IPv4Address(int(mask, 16))) if mask.startswith('0x') else mask
            subnet = ipaddress.IPv4Interface(f'{address}/{mask}').network
            target = ipaddress.IPv4Address(args.target)
            found = target in subnet and target not in (subnet.network_address, subnet.broadcast_address, ipaddress.IPv4Address(args.source))
    if not found or not all(1 <= p <= 65535 for p in [args.mount_port, args.nfs_port]):
        parser.error('Selected source/subnet or returned ports invalid')
    print(json.dumps({'event': 'plan', 'execute': args.execute, 'target': args.target,
                      'readHeader': args.read_header, 'maxExports': 4, 'maxReadBytesPerFile': 4096}), flush=True)
    if not args.execute:
        return
    xid = 0x415a1000
    started = time.monotonic()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(2)
        if sys.platform == 'darwin':
            sock.setsockopt(socket.IPPROTO_IP, 25, socket.if_nametoindex(args.interface))
        sock.bind((args.source, 0))

        def call(program, version, procedure, port, payload=b''):
            nonlocal xid
            if time.monotonic() - started > 45:
                raise TimeoutError('Overall 45-second limit reached')
            xid += 1
            # Standard AUTH_UNIX with empty hostname, uid/gid zero, no groups.
            auth = struct.pack('!5I', 0, 0, 0, 0, 0)
            packet = struct.pack('!6I', xid, 0, 2, program, version, procedure)
            packet += struct.pack('!2I', 1, len(auth)) + auth + struct.pack('!2I', 0, 0) + payload
            sock.connect((args.target, port))
            sock.send(packet)
            return rpc_result(sock.recv(16384), xid)

        exports = exports_from(call(100005, 1, 5, args.mount_port))
        print(json.dumps({'event': 'exports', 'exports': exports}, ensure_ascii=False), flush=True)
        for export in exports[:4]:
            root = export['path']
            try:
                body = call(100005, 1, 1, args.mount_port, text(root))
                if uint(body) != 0 or len(body) < 36:
                    raise ValueError(f'Mount status {uint(body)}')
                root_handle = body[4:36]
                print(json.dumps({'event': 'rpc-handle', 'export': root}), flush=True)
            except (OSError, ValueError) as error:
                print(json.dumps({'event': 'rpc-handle-error', 'export': root, 'error': str(error)}), flush=True)
                continue
            for path in ['PIONEER/rekordbox/exportLibrary.db', 'PIONEER/rekordbox/export.pdb']:
                try:
                    handle = root_handle
                    size = None
                    for name in path.split('/'):
                        body = call(100003, 2, 4, args.nfs_port, handle + text(name))
                        status = uint(body)
                        if status != 0 or len(body) < 104:
                            raise ValueError(f'Lookup {name}: NFS status {status}')
                        handle = body[4:36]
                        size = uint(body, 56)
                    result = {'event': 'database-file', 'export': root, 'path': path, 'size': size}
                    if args.read_header:
                        body = call(100003, 2, 6, args.nfs_port, handle + struct.pack('!3I', 0, min(size, 4096), 0))
                        status = uint(body)
                        if status != 0 or len(body) < 76:
                            raise ValueError(f'Read NFS status {status}')
                        data, _ = read_opaque(body, 72)
                        if len(data) > 4096:
                            raise ValueError('Read reply exceeded requested header limit')
                        result.update({'headerBytes': len(data), 'headerHex': data.hex()})
                    print(json.dumps(result), flush=True)
                except (OSError, ValueError) as error:
                    print(json.dumps({'event': 'database-error', 'export': root, 'path': path, 'error': str(error)}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print(json.dumps({'event': 'probe-error', 'error': str(error)}), flush=True)
        raise SystemExit(1)
