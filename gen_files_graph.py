import json

graph = json.load(open('D:/HoloGramHG/hologram_graph.json', encoding='utf-8'))

file_nodes = {}
for n in graph['nodes']:
    loc = n.get('location','')
    if not loc: continue
    f = loc.split(':')[0]
    file_nodes.setdefault(f, []).append(n['id'])

node_lookup = {n['id']: n for n in graph['nodes']}

file_edges = {}
for e in graph.get('edges', []):
    src = node_lookup.get(e['source'], {})
    tgt = node_lookup.get(e['target'], {})
    sf = (src.get('location','') or '').split(':')[0]
    tf = (tgt.get('location','') or '').split(':')[0]
    if sf and tf and sf != tf:
        key = (sf, tf)
        file_edges[key] = file_edges.get(key, 0) + 1

out = {
    'nodes': [{'id': f, 'name': f.split('/')[-1].split('\\')[-1], 'type': 'file', 'symbol_count': len(ids)} for f, ids in file_nodes.items()],
    'edges': [{'source': s, 'target': t, 'weight': w, 'type': 'imports'} for (s,t), w in file_edges.items()]
}
json.dump(out, open('D:/HoloGramHG/hologram_graph_files.json', 'w'), indent=2)
print(f'files={len(out["nodes"])} edges={len(out["edges"])}')
