# main.py — entry point, orchestrates data flow

from db import connect_db, Config
from worker import process

_app_config = Config(host="localhost")

async def main():
    db = connect_db(_app_config)
    data = await fetch_remote()
    result = process(db, data)
    save_result(result)

async def fetch_remote():
    # await triggers dataflow
    return await http_get("/api/data")

def save_result(data):
    with open("/tmp/out.json", "w") as f:
        f.write(str(data))
