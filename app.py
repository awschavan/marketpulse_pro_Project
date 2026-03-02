import os
from functools import wraps

from flask import Flask, flash, jsonify, redirect, render_template, request, url_for
from flask_login import LoginManager, current_user, login_required, login_user, logout_user
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.security import check_password_hash, generate_password_hash

from models import AlertLog, AlertRule, User, WatchlistItem, db
from services import AlertEngine, LiveStreamManager, MarketDataService, PriceCache, default_watchlist_for_user


socketio = SocketIO(cors_allowed_origins="*", async_mode="threading")
login_manager = LoginManager()
market_service = MarketDataService()
cache = PriceCache(redis_url=os.getenv("REDIS_URL"), ttl_seconds=30)
alert_engine = AlertEngine()
stream_manager = LiveStreamManager(socketio, cache, market_service, alert_engine)


def create_app():
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "marketpulse-pro-change-me")
    app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv(
        "DATABASE_URL", "sqlite:///marketpulse_pro.db"
    )
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["NEWS_API_KEY"] = os.getenv("NEWS_API_KEY", "")
    app.config["SUPPORTED_SYMBOLS"] = os.getenv(
        "SUPPORTED_SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT"
    )

    db.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = "login"
    socketio.init_app(app)

    symbols = [s.strip().upper() for s in app.config["SUPPORTED_SYMBOLS"].split(",") if s.strip()]
    stream_manager.configure_symbols(symbols)

    register_routes(app)
    register_socket_events()

    with app.app_context():
        db.create_all()
        seed_initial_data(symbols)
        stream_manager.start()

    return app


def seed_initial_data(symbols: list[str]):
    admin = User.query.filter_by(username="admin").first()
    if not admin:
        admin = User(
            username="admin",
            email="admin@marketpulse.local",
            password=generate_password_hash("Admin@123"),
            role="admin",
        )
        db.session.add(admin)
        db.session.commit()

    if not WatchlistItem.query.filter_by(user_id=admin.id).first():
        for symbol in symbols[:3]:
            db.session.add(WatchlistItem(user_id=admin.id, symbol=symbol))
        db.session.commit()

    demo = User.query.filter_by(username="demo").first()
    if not demo:
        demo = User(
            username="demo",
            email="demo@marketpulse.local",
            password=generate_password_hash("Demo@123"),
            role="user",
        )
        db.session.add(demo)
        db.session.commit()

    if not WatchlistItem.query.filter_by(user_id=demo.id).first():
        for symbol in symbols[:3]:
            db.session.add(WatchlistItem(user_id=demo.id, symbol=symbol))
        db.session.commit()


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_user.is_authenticated:
            return redirect(url_for("login"))
        if current_user.role != "admin":
            flash("Admin access required.", "error")
            return redirect(url_for("dashboard"))
        return fn(*args, **kwargs)

    return wrapper


def register_routes(app):
    def build_watchlist_snapshot(user_id: int):
        symbols = default_watchlist_for_user(user_id) or stream_manager.supported_symbols[:3]
        snapshots = []
        for symbol in symbols:
            latest = cache.get_latest(symbol)
            candles = stream_manager.latest_candles(symbol, limit=3)
            if not candles and latest is None:
                continue

            last_close = float(latest["close"]) if latest else float(candles[-1]["close"])
            prev_close = float(candles[-2]["close"]) if len(candles) > 1 else last_close
            change_pct = 0.0
            if prev_close:
                change_pct = ((last_close - prev_close) / prev_close) * 100

            snapshots.append(
                {
                    "symbol": symbol,
                    "price": round(last_close, 4),
                    "change_pct": round(change_pct, 2),
                }
            )
        return snapshots

    @app.route("/")
    @login_required
    def dashboard():
        symbols = stream_manager.supported_symbols
        watchlist = default_watchlist_for_user(current_user.id)
        default_symbol = watchlist[0] if watchlist else symbols[0]
        return render_template(
            "dashboard.html",
            user=current_user,
            symbols=symbols,
            default_symbol=default_symbol,
            watchlist=watchlist or symbols[:3],
            is_redis_enabled=bool(cache.redis_client),
        )

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if current_user.is_authenticated:
            return redirect(url_for("dashboard"))
        if request.method == "POST":
            username = request.form.get("username", "").strip()
            password = request.form.get("password", "")
            user = User.query.filter_by(username=username).first()
            if user and check_password_hash(user.password, password):
                login_user(user)
                return redirect(url_for("dashboard"))
            flash("Invalid username or password.", "error")
        return render_template("login.html")

    @app.route("/login/demo", methods=["POST"])
    def login_demo():
        if current_user.is_authenticated:
            return redirect(url_for("dashboard"))

        demo_user = User.query.filter_by(username="demo").first()
        if not demo_user:
            demo_user = User(
                username="demo",
                email="demo@marketpulse.local",
                password=generate_password_hash("Demo@123"),
                role="user",
            )
            db.session.add(demo_user)
            db.session.commit()

            for symbol in stream_manager.supported_symbols[:3]:
                db.session.add(WatchlistItem(user_id=demo_user.id, symbol=symbol))
            db.session.commit()

        login_user(demo_user)
        flash("Logged in to beginner demo account.", "success")
        return redirect(url_for("dashboard"))

    @app.route("/register", methods=["GET", "POST"])
    def register():
        if current_user.is_authenticated:
            return redirect(url_for("dashboard"))
        if request.method == "POST":
            username = request.form.get("username", "").strip()
            email = request.form.get("email", "").strip() or None
            password = request.form.get("password", "")
            if not username or len(password) < 6:
                flash("Username and password (min 6 chars) are required.", "error")
                return render_template("register.html")
            if User.query.filter_by(username=username).first():
                flash("Username already exists.", "error")
                return render_template("register.html")
            user = User(
                username=username,
                email=email,
                password=generate_password_hash(password),
                role="user",
            )
            db.session.add(user)
            db.session.commit()

            defaults = stream_manager.supported_symbols[:3]
            for symbol in defaults:
                db.session.add(WatchlistItem(user_id=user.id, symbol=symbol))
            db.session.commit()

            flash("Account created. Please login.", "success")
            return redirect(url_for("login"))
        return render_template("register.html")

    @app.route("/logout")
    @login_required
    def logout():
        logout_user()
        return redirect(url_for("login"))

    @app.route("/admin")
    @admin_required
    def admin_panel():
        users = User.query.order_by(User.created_at.desc()).all()
        alerts = AlertLog.query.order_by(AlertLog.created_at.desc()).limit(50).all()
        return render_template("admin.html", users=users, alerts=alerts)

    @app.route("/api/bootstrap")
    @login_required
    def api_bootstrap():
        symbol = request.args.get("symbol", stream_manager.supported_symbols[0]).upper()
        interval = (request.args.get("interval", "1m") or "1m").lower()
        if symbol not in stream_manager.supported_symbols:
            return jsonify({"error": "Unsupported symbol"}), 400

        allowed_intervals = {"1m", "5m", "15m", "1h"}
        if interval not in allowed_intervals:
            return jsonify({"error": "Unsupported interval"}), 400

        candles = (
            stream_manager.latest_candles(symbol, limit=320)
            if interval == "1m"
            else market_service.fetch_historical_klines(symbol, interval=interval, limit=320)
        )
        analysis = market_service.build_analysis(symbol, candles)
        alerts = (
            AlertLog.query.filter_by(user_id=current_user.id, symbol=symbol)
            .order_by(AlertLog.created_at.desc())
            .limit(20)
            .all()
        )
        return jsonify(
            {
                "symbol": symbol,
                "interval": interval,
                "candles": candles,
                "analysis": analysis,
                "latest": cache.get_latest(symbol),
                "watchlist_snapshot": build_watchlist_snapshot(current_user.id),
                "alerts": [
                    {
                        "id": a.id,
                        "message": a.message,
                        "severity": a.severity,
                        "created_at": a.created_at.isoformat(),
                    }
                    for a in alerts
                ],
            }
        )

    @app.route("/api/watchlist/snapshot")
    @login_required
    def api_watchlist_snapshot():
        return jsonify({"items": build_watchlist_snapshot(current_user.id)})

    @app.route("/api/watchlist", methods=["GET", "POST", "DELETE"])
    @login_required
    def api_watchlist():
        if request.method == "GET":
            symbols = default_watchlist_for_user(current_user.id)
            return jsonify({"symbols": symbols})

        payload = request.get_json(silent=True) or {}
        symbol = (payload.get("symbol") or "").upper().strip()
        if symbol not in stream_manager.supported_symbols:
            return jsonify({"error": "Unsupported symbol"}), 400

        if request.method == "POST":
            exists = WatchlistItem.query.filter_by(user_id=current_user.id, symbol=symbol).first()
            if exists:
                return jsonify({"ok": True})
            db.session.add(WatchlistItem(user_id=current_user.id, symbol=symbol))
            db.session.commit()
            return jsonify({"ok": True})

        item = WatchlistItem.query.filter_by(user_id=current_user.id, symbol=symbol).first()
        if item:
            db.session.delete(item)
            db.session.commit()
        return jsonify({"ok": True})

    @app.route("/api/alerts/rules", methods=["GET", "POST", "DELETE"])
    @login_required
    def api_alert_rules():
        if request.method == "GET":
            rows = AlertRule.query.filter_by(user_id=current_user.id).order_by(AlertRule.created_at.desc()).all()
            return jsonify(
                {
                    "rules": [
                        {
                            "id": r.id,
                            "symbol": r.symbol,
                            "rule_type": r.rule_type,
                            "threshold": r.threshold,
                            "is_active": r.is_active,
                        }
                        for r in rows
                    ]
                }
            )

        payload = request.get_json(silent=True) or {}
        if request.method == "POST":
            symbol = (payload.get("symbol") or "").upper()
            rule_type = (payload.get("rule_type") or "").strip()
            threshold = payload.get("threshold")
            if symbol not in stream_manager.supported_symbols:
                return jsonify({"error": "Unsupported symbol"}), 400
            allowed = {"price_above", "price_below", "rsi_overbought", "rsi_oversold", "breakout_up"}
            if rule_type not in allowed:
                return jsonify({"error": "Invalid rule type"}), 400

            if rule_type in {"price_above", "price_below"}:
                try:
                    threshold = float(threshold)
                except (TypeError, ValueError):
                    return jsonify({"error": "Threshold required for price rules"}), 400
            else:
                threshold = None

            rule = AlertRule(
                user_id=current_user.id,
                symbol=symbol,
                rule_type=rule_type,
                threshold=threshold,
                is_active=True,
            )
            db.session.add(rule)
            db.session.commit()
            return jsonify({"ok": True, "rule_id": rule.id})

        rule_id = payload.get("rule_id")
        row = AlertRule.query.filter_by(id=rule_id, user_id=current_user.id).first()
        if row:
            db.session.delete(row)
            db.session.commit()
        return jsonify({"ok": True})

    @app.route("/api/alerts/logs")
    @login_required
    def api_alert_logs():
        logs = (
            AlertLog.query.filter_by(user_id=current_user.id)
            .order_by(AlertLog.created_at.desc())
            .limit(50)
            .all()
        )
        return jsonify(
            {
                "logs": [
                    {
                        "id": a.id,
                        "symbol": a.symbol,
                        "message": a.message,
                        "severity": a.severity,
                        "created_at": a.created_at.isoformat(),
                    }
                    for a in logs
                ]
            }
        )


def register_socket_events():
    @socketio.on("connect")
    def on_connect():
        if not current_user.is_authenticated:
            return False
        emit("server_status", {"status": "connected"})

    @socketio.on("subscribe_symbol")
    def on_subscribe(data):
        symbol = (data.get("symbol") or "").upper()
        if symbol not in stream_manager.supported_symbols:
            emit("error", {"message": "Unsupported symbol"})
            return
        room = f"symbol:{symbol}"
        for s in stream_manager.supported_symbols:
            leave_room(f"symbol:{s}")
        join_room(room)
        latest = cache.get_latest(symbol)
        if latest:
            emit("price_update", latest)


app = create_app()


if __name__ == "__main__":
    debug_mode = os.getenv("FLASK_DEBUG", "0") == "1"
    socketio.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000")),
        debug=debug_mode,
        use_reloader=False,
    )
