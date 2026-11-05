#!/usr/bin/env python3
"""Bounded read-only metadata-service discovery; no DJ participation or file access.

Dry-run is the default. --execute sends one RemoteDBServer port query and two
portmapper GETPORT queries. It never sends RPC SET/UNSET or NFS write calls.
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


def rpc_getport(xid, program, version):
    return struct.pack('!14I', xid, 0, 2, 100000, 2, 3,
                       0, 0, 0, 0, program, version, 17, 0)


def parse_rpc_port(data, xid):
    if len(data) < 24:
        raise ValueError('Short RPC reply')
    rxid, reply, accepted, _flavor, verifier_length = struct.unpack('!5I', data[:20])
    if (rxid, reply, accepted) != (xid, 1, 0):
        raise ValueError('Unexpected or rejected RPC reply')
    offset = 20 + ((verifier_length + 3) // 4) * 4
    if offset + 8 > len(data):
        raise ValueError('Truncated RPC result')
    status, port = struct.unpack('!2I', data[offset:offset + 8])
    if status != 0 or port > 65535:
        raise ValueError('RPC GETPORT unsuccessful')
    return port


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interface', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    output = subprocess.run(['ifconfig', args.interface], capture_output=True,
                            text=True, check=True).stdout
    candidates = re.findall(r'\binet (\d+\.\d+\.\d+\.\d+) netmask (\S+)', output)
    selected = None
    for address, mask in candidates:
        if address == args.source:
            netmask = str(ipaddress.IPv4Address(int(mask, 16))) if mask.startswith('0x') else mask
            selected = ipaddress.IPv4Interface(f'{address}/{netmask}')
    target = ipaddress.IPv4Address(args.target)
    if selected is None or target not in selected.network or target in (
            selected.ip, selected.network.broadcast_address, selected.network.network_address):
        parser.error('Source must belong to the selected interface; target must be a different host on its subnet')
    plan = {'event': 'plan', 'interface': args.interface, 'source': args.source,
            'target': args.target, 'execute': args.execute,
            'operations': ['TCP12523 RemoteDBServer', 'UDP111 GETPORT mount v1', 'UDP111 GETPORT NFS v2']}
    print(json.dumps(plan), flush=True)
    if not args.execute:
        return

    def make_socket(kind):
        sock = socket.socket(socket.AF_INET, kind)
        sock.settimeout(2)
        if sys.platform == 'darwin':
            sock.setsockopt(socket.IPPROTO_IP, 25, socket.if_nametoindex(args.interface))
        sock.bind((args.source, 0))
        return sock

    start = time.monotonic()
    try:
        with make_socket(socket.SOCK_STREAM) as sock:
            sock.connect((args.target, 12523))
            sock.sendall(bytes.fromhex('0000000f') + b'RemoteDBServer\0')
            data = b''
            while len(data) < 2:
                chunk = sock.recv(2 - len(data))
                if not chunk:
                    break
                data += chunk
            result = {'operation': 'dbserver-port', 'replyHex': data.hex()}
            if len(data) == 2:
                result['port'] = int.from_bytes(data, 'big')
            print(json.dumps(result), flush=True)
    except OSError as error:
        print(json.dumps({'operation': 'dbserver-port', 'error': str(error)}), flush=True)
    for xid, program, version, label in [(0x415a0001, 100005, 1, 'mount'),
                                          (0x415a0002, 100003, 2, 'nfs')]:
        try:
            with make_socket(socket.SOCK_DGRAM) as sock:
                sock.connect((args.target, 111))
                sock.send(rpc_getport(xid, program, version))
                data = sock.recv(4096)
                print(json.dumps({'operation': f'rpc-getport-{label}',
                                  'replyHex': data.hex(), 'port': parse_rpc_port(data, xid)}), flush=True)
        except (OSError, ValueError) as error:
            print(json.dumps({'operation': f'rpc-getport-{label}', 'error': str(error)}), flush=True)
    print(json.dumps({'event': 'finished', 'elapsedSeconds': time.monotonic() - start}), flush=True)


if __name__ == '__main__':
    main()
