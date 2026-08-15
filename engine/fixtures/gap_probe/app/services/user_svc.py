"""User service - the real implementation."""
from db import Database


class UserService:
    def create(self, name: str) -> int:
        db = Database()
        return db.insert(name)

    def get_by_id(self, uid: int) -> dict:
        return {"id": uid, "name": "alice"}


def global_helper():
    return "shared"
