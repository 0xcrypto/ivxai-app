#!/usr/bin/env python3
"""A minimal stdio MCP server for exercising the bridge's /mcp/stdio route."""
import sys
import json

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if 'id' not in msg:
        continue  # notification: nothing to answer
    method = msg.get('method')
    if method == 'initialize':
        resp = {
            'jsonrpc': '2.0', 'id': msg['id'],
            'result': {
                'protocolVersion': '2025-06-18',
                'capabilities': {'tools': {}},
                'serverInfo': {'name': 'test-mcp', 'version': '0.1.0'},
            },
        }
    elif method == 'tools/list':
        resp = {
            'jsonrpc': '2.0', 'id': msg['id'],
            'result': {'tools': [{
                'name': 'echo',
                'description': 'Echoes its input',
                'inputSchema': {
                    'type': 'object',
                    'properties': {'text': {'type': 'string'}},
                    'required': ['text'],
                },
            }]},
        }
    elif method == 'tools/call':
        args = msg.get('params', {}).get('arguments', {})
        resp = {
            'jsonrpc': '2.0', 'id': msg['id'],
            'result': {'content': [{'type': 'text', 'text': 'echo: ' + str(args.get('text', ''))}]},
        }
    else:
        resp = {'jsonrpc': '2.0', 'id': msg['id'], 'error': {'code': -32601, 'message': 'unknown method'}}
    sys.stdout.write(json.dumps(resp) + '\n')
    sys.stdout.flush()