const { exec } = require('child_process');

async function loadMod(name) {
    return await import(name);
}

function runShell(cmd) {
    exec(cmd);
}

async function getData() {
    return await fetch('https://api.example.com');
}

function runCode(code) {
    eval(code);
}

function makeFn(body) {
    return new Function(body);
}
