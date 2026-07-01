// helper.js — utility functions with async patterns

let cache = {};

function getCached(key) {
    return cache[key] || null;
}

function setCached(key, value) {
    cache[key] = value;
}

async function loadResource(url) {
    let cached = getCached(url);
    if (cached) {
        return cached;
    }
    let data = await fetch(url);
    setCached(url, data);
    return data;
}

function transform(items) {
    return items
        .filter(item => item.active)
        .map(item => ({ id: item.id, name: item.name }));
}

module.exports = { getCached, setCached, loadResource, transform };
