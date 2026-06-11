from flask import Flask, render_template, jsonify, request, session
import threading
from scraper import LetterboxdScraper
from data_manager import DataManager
from storage import user_data_exists, load_user_data, save_user_data
import secrets

app = Flask(__name__)
app.secret_key = secrets.token_hex(16)  # Session için gerekli

# Store scrapers and data managers per session
sessions = {}
session_lock = threading.Lock()


def _get_session_id():
    session_id = session.get("user_id")
    if not session_id:
        session_id = secrets.token_hex(16)
        session["user_id"] = session_id
    return session_id


@app.route("/")
def index():
    _get_session_id()
    return render_template("index.html")


@app.route("/start-scrape", methods=["POST"])
def start_scrape():
    username = request.json.get("username", "").strip()

    if not username:
        return jsonify({"status": "error", "message": "Username required"}), 400

    session_id = _get_session_id()

    # If we already have cached data for this username, use it instead of scraping.
    if user_data_exists(username):
        data = load_user_data(username)
        data_manager = DataManager()
        data_manager.set_data(data)
        with session_lock:
            sessions[session_id] = {
                "scraper": None,
                "data_manager": data_manager,
                "username": username,
            }
        return jsonify({"status": "cached", "count": len(data)})

    # No cache -> run a full scrape in the background.
    scraper = LetterboxdScraper(username)
    data_manager = DataManager()
    with session_lock:
        sessions[session_id] = {
            "scraper": scraper,
            "data_manager": data_manager,
            "username": username,
        }

    def run_scrape():
        try:
            data = scraper.scrape()
            data_manager.set_data(data)
            save_user_data(username, data)
        except Exception as e:
            scraper.set_error(str(e))

    threading.Thread(target=run_scrape, daemon=True).start()
    return jsonify({"status": "started"})


@app.route("/refresh", methods=["POST"])
def refresh():
    """Incrementally scrape only entries newer than what is cached."""
    session_id = session.get("user_id")

    with session_lock:
        sess = sessions.get(session_id)

    if not sess:
        return jsonify({"status": "error", "message": "No active session"}), 404

    username = sess["username"]
    data_manager = sess["data_manager"]
    existing = data_manager.get_data()
    known_ids = {f.get("entry_id") for f in existing if f.get("entry_id")}

    scraper = LetterboxdScraper(username)
    with session_lock:
        sessions[session_id]["scraper"] = scraper

    def run_refresh():
        try:
            new_films = scraper.scrape(known_ids=known_ids)
            if new_films:
                merged = new_films + existing  # diary is newest-first
                data_manager.set_data(merged)
                save_user_data(username, merged)
        except Exception as e:
            scraper.set_error(str(e))

    threading.Thread(target=run_refresh, daemon=True).start()
    return jsonify({"status": "started"})


@app.route("/status")
def status():
    session_id = session.get("user_id")

    if not session_id:
        return jsonify({"error": "No session"}), 404

    with session_lock:
        sess = sessions.get(session_id)

    if not sess:
        return jsonify({"error": "No active scrape"}), 404

    scraper = sess["scraper"]
    if scraper is None:
        # Data came from cache; nothing is scraping.
        return jsonify({"done": True, "percentage": 100, "stage": "done"})

    return jsonify(scraper.get_progress())


@app.route("/result")
def result():
    session_id = session.get("user_id")

    if not session_id:
        return jsonify({"error": "No session"}), 404

    with session_lock:
        sess = sessions.get(session_id)

    if not sess:
        return jsonify({"error": "No data available"}), 404

    data_manager = sess["data_manager"]
    return jsonify(data_manager.get_data())


if __name__ == "__main__":
    app.run(debug=True)
