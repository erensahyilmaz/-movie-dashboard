import json
import os
import re
import threading

# All scraped user data is persisted here as <username>.json
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# Serialize file access so concurrent scrape threads don't corrupt a file.
_file_lock = threading.Lock()


def _safe_name(username):
    """Turn a Letterboxd username into a safe file name."""
    name = (username or "").strip().lower()
    name = re.sub(r"[^a-z0-9_-]", "_", name)
    return name or "_unknown"


def _path_for(username):
    return os.path.join(DATA_DIR, _safe_name(username) + ".json")


def user_data_exists(username):
    """True if we already have cached data for this username."""
    path = _path_for(username)
    return os.path.isfile(path) and os.path.getsize(path) > 0


def load_user_data(username):
    """Load the cached film list for a username (empty list if none)."""
    path = _path_for(username)
    if not os.path.isfile(path):
        return []
    with _file_lock:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError):
            return []


def save_user_data(username, data):
    """Persist the film list for a username as pretty-printed JSON."""
    os.makedirs(DATA_DIR, exist_ok=True)
    path = _path_for(username)
    with _file_lock:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
