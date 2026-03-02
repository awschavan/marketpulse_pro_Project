import json
import os
import smtplib
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from email.message import EmailMessage

import pandas as pd
import requests
import websocket
from flask import current_app

from ml_engine import PredictionEngine, summarize_market_state
from models import AlertLog, AlertRule, PriceCandle, User, WatchlistItem, db

try:
    import redis
except ImportError:  # pragma: no cover
    redis = None


class PriceCache:
    def __init__(self, redis_url: str | None, ttl_seconds: int = 30):
        self.ttl_seconds = ttl_seconds
        self.fallback = {}
        self.redis_client = None
        if redis and redis_url:
            try:
                self.redis_client = redis.from_url(redis_url, decode_responses=True)
                self.redis_client.ping()
            except Exception:
                self.redis_client = None

    def set_latest(self, symbol: str, payload: dict):
        key = f"latest:{symbol.upper()}"
        if self.redis_client:
            self.redis_client.setex(key, self.ttl_seconds, json.dumps(payload))
            return
        self.fallback[key] = {"expires": time.time() + self.ttl_seconds, "value": payload}

    def get_latest(self, symbol: str):
        key = f"latest:{symbol.upper()}"
        if self.redis_client:
            raw = self.redis_client.get(key)
            return json.loads(raw) if raw else None
        item = self.fallback.get(key)
        if not item:
            return None
        if item["expires"] < time.time():
            self.fallback.pop(key, None)
            return None
        return item["value"]


class MarketDataService:
    REST_URL = "https://api.binance.com/api/v3/klines"
    NEWS_URL = "https://newsapi.org/v2/everything"

    def __init__(self):
        self.session = requests.Session()
        self.prediction_engine = PredictionEngine()

    def fetch_historical_klines(self, symbol: str, interval: str = "1m", limit: int = 600) -> list[dict]:
        params = {"symbol": symbol.upper(), "interval": interval, "limit": limit}
        delay = 1
        for _ in range(4):
            try:
                resp = self.session.get(self.REST_URL, params=params, timeout=15)
                resp.raise_for_status()
                rows = resp.json()
                return [
                    {
                        "open_time": int(r[0]),
                        "open": float(r[1]),
                        "high": float(r[2]),
                        "low": float(r[3]),
                        "close": float(r[4]),
                        "volume": float(r[5]),
                        "close_time": int(r[6]),
                    }
                    for r in rows
                ]
            except requests.RequestException:
                time.sleep(delay)
                delay *= 2
        return []

    def get_news_sentiment(self, symbol: str) -> dict:
        api_key = current_app.config.get("NEWS_API_KEY")
        asset = symbol.replace("USDT", "")
        if not api_key:
            return {"score": 0.0, "label": "Neutral", "articles": []}

        params = {
            "q": f"{asset} crypto OR {asset} coin",
            "sortBy": "publishedAt",
            "language": "en",
            "pageSize": 6,
            "apiKey": api_key,
        }
        try:
            resp = self.session.get(self.NEWS_URL, params=params, timeout=10)
            resp.raise_for_status()
            articles = resp.json().get("articles", [])
        except requests.RequestException:
            return {"score": 0.0, "label": "Neutral", "articles": []}

        positive_words = {"surge", "rally", "bullish", "beats", "approval", "growth", "record", "gain"}
        negative_words = {"drop", "crash", "bearish", "lawsuit", "ban", "hack", "loss", "decline"}

        score = 0
        formatted = []
        for article in articles[:6]:
            title = (article.get("title") or "").lower()
            score += sum(1 for w in positive_words if w in title)
            score -= sum(1 for w in negative_words if w in title)
            formatted.append(
                {
                    "title": article.get("title"),
                    "source": (article.get("source") or {}).get("name"),
                    "url": article.get("url"),
                    "published_at": article.get("publishedAt"),
                }
            )

        label = "Neutral"
        if score > 2:
            label = "Positive"
        elif score < -2:
            label = "Negative"

        return {"score": float(score), "label": label, "articles": formatted}

    def to_dataframe(self, candles: list[dict]) -> pd.DataFrame:
        if not candles:
            return pd.DataFrame(columns=["open_time", "open", "high", "low", "close", "volume", "close_time"])
        df = pd.DataFrame(candles)
        return df.sort_values("open_time").reset_index(drop=True)

    def build_analysis(self, symbol: str, candles: list[dict]) -> dict:
        df = self.to_dataframe(candles)
        indicators = summarize_market_state(df)
        prediction = self.prediction_engine.predict_next_close(df)
        news = self.get_news_sentiment(symbol)
        return {"indicators": indicators, "prediction": prediction, "news": news}


class AlertEngine:
    def __init__(self):
        self.last_close_by_symbol = {}
        self.email_enabled = bool(os.getenv("SMTP_HOST"))
        self.telegram_enabled = bool(os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("TELEGRAM_CHAT_ID"))
        self.smtp_host = os.getenv("SMTP_HOST", "")
        self.smtp_port = int(os.getenv("SMTP_PORT", "587"))
        self.smtp_username = os.getenv("SMTP_USERNAME", "")
        self.smtp_password = os.getenv("SMTP_PASSWORD", "")
        self.smtp_from = os.getenv("SMTP_FROM", self.smtp_username or "alerts@marketpulse.local")
        self.smtp_use_tls = os.getenv("SMTP_USE_TLS", "1").strip().lower() not in {"0", "false", "no"}
        self.smtp_use_ssl = os.getenv("SMTP_USE_SSL", "0").strip().lower() in {"1", "true", "yes"}
        self.default_alert_email = os.getenv("ALERT_EMAIL_TO", "").strip()
        self.email_cooldown_seconds = max(0, int(os.getenv("ALERT_EMAIL_COOLDOWN_SEC", "60")))
        self.last_email_sent_at = {}
        self.http = requests.Session()

    def evaluate(self, symbol: str, close_price: float, indicators: dict):
        rules = AlertRule.query.filter_by(symbol=symbol.upper(), is_active=True).all()
        prev_close = self.last_close_by_symbol.get(symbol.upper())
        self.last_close_by_symbol[symbol.upper()] = close_price

        for rule in rules:
            fired = False
            message = ""
            threshold = rule.threshold if rule.threshold is not None else 0.0
            rsi = indicators.get("rsi", 50.0)

            if rule.rule_type == "price_above" and close_price > threshold:
                fired = True
                message = f"{symbol} crossed above {threshold:.4f}. Current: {close_price:.4f}"
            elif rule.rule_type == "price_below" and close_price < threshold:
                fired = True
                message = f"{symbol} dropped below {threshold:.4f}. Current: {close_price:.4f}"
            elif rule.rule_type == "rsi_overbought" and rsi >= 70:
                fired = True
                message = f"{symbol} RSI overbought at {rsi:.2f}"
            elif rule.rule_type == "rsi_oversold" and rsi <= 30:
                fired = True
                message = f"{symbol} RSI oversold at {rsi:.2f}"
            elif rule.rule_type == "breakout_up" and prev_close is not None and close_price > prev_close * 1.01:
                fired = True
                message = f"{symbol} breakout up detected (+1% from last close)"

            if fired:
                self._persist_and_notify(rule.user_id, symbol, message)

    def _persist_and_notify(self, user_id: int, symbol: str, message: str):
        payload = {"timestamp": datetime.now(timezone.utc).isoformat()}
        log = AlertLog(
            user_id=user_id,
            symbol=symbol.upper(),
            message=message,
            severity="warning",
            payload=json.dumps(payload),
        )
        db.session.add(log)
        db.session.commit()
        self._notify_external(user_id, symbol.upper(), message)

    def _notify_external(self, user_id: int, symbol: str, message: str):
        if self.telegram_enabled:
            token = os.getenv("TELEGRAM_BOT_TOKEN")
            chat_id = os.getenv("TELEGRAM_CHAT_ID")
            try:
                self.http.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    data={"chat_id": chat_id, "text": message},
                    timeout=8,
                )
            except requests.RequestException:
                pass

        if self.email_enabled:
            recipient = self._resolve_alert_email(user_id)
            if not recipient:
                return
            if self._is_email_throttled(recipient, symbol, message):
                return
            self._send_email(recipient, symbol, message)

    def _resolve_alert_email(self, user_id: int):
        if user_id:
            user = User.query.get(user_id)
            if user and user.email:
                return user.email.strip()
        return self.default_alert_email or None

    def _is_email_throttled(self, recipient: str, symbol: str, message: str):
        if self.email_cooldown_seconds <= 0:
            return False
        key = f"{recipient}|{symbol}|{message}"
        now_ts = time.time()
        last_ts = self.last_email_sent_at.get(key, 0)
        if (now_ts - last_ts) < self.email_cooldown_seconds:
            return True
        self.last_email_sent_at[key] = now_ts
        return False

    def _send_email(self, recipient: str, symbol: str, message: str):
        subject = f"[MarketPulse Alert] {symbol}"
        now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        body = (
            "MarketPulse Pro alert notification\n\n"
            f"Symbol: {symbol}\n"
            f"Message: {message}\n"
            f"Time: {now_utc}\n"
        )

        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = self.smtp_from
        msg["To"] = recipient
        msg.set_content(body)

        try:
            if self.smtp_use_ssl:
                with smtplib.SMTP_SSL(self.smtp_host, self.smtp_port, timeout=10) as smtp:
                    if self.smtp_username and self.smtp_password:
                        smtp.login(self.smtp_username, self.smtp_password)
                    smtp.send_message(msg)
            else:
                with smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=10) as smtp:
                    smtp.ehlo()
                    if self.smtp_use_tls:
                        smtp.starttls()
                        smtp.ehlo()
                    if self.smtp_username and self.smtp_password:
                        smtp.login(self.smtp_username, self.smtp_password)
                    smtp.send_message(msg)
        except Exception:
            # Non-blocking by design: alerts should never crash the stream thread.
            pass


class LiveStreamManager:
    def __init__(self, socketio, cache: PriceCache, market_service: MarketDataService, alert_engine: AlertEngine):
        self.socketio = socketio
        self.cache = cache
        self.market_service = market_service
        self.alert_engine = alert_engine
        self.running = False
        self.thread = None
        self.supported_symbols = []
        self.symbol_subscribers = defaultdict(int)
        self._lock = threading.Lock()

    def configure_symbols(self, symbols: list[str]):
        self.supported_symbols = [s.upper() for s in symbols]

    def start(self):
        with self._lock:
            if self.running:
                return
            self.running = True
            self.thread = threading.Thread(target=self._run_forever, daemon=True)
            self.thread.start()

    def _run_forever(self):
        if not self.supported_symbols:
            return
        stream_path = "/".join([f"{s.lower()}@kline_1m" for s in self.supported_symbols])
        ws_url = f"wss://stream.binance.com:9443/stream?streams={stream_path}"

        while self.running:
            try:
                ws = websocket.WebSocketApp(
                    ws_url,
                    on_message=self._on_message,
                    on_error=lambda *_: None,
                    on_close=lambda *_: None,
                )
                ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception:
                pass
            time.sleep(2)

    def _on_message(self, ws, raw_message):
        del ws
        payload = json.loads(raw_message)
        stream_name = payload.get("stream", "")
        data = payload.get("data", {})
        kline = data.get("k", {})
        symbol = stream_name.split("@")[0].upper()
        if symbol not in self.supported_symbols:
            return

        event = {
            "symbol": symbol,
            "open_time": int(kline.get("t", 0)),
            "close_time": int(kline.get("T", 0)),
            "open": float(kline.get("o", 0.0)),
            "high": float(kline.get("h", 0.0)),
            "low": float(kline.get("l", 0.0)),
            "close": float(kline.get("c", 0.0)),
            "volume": float(kline.get("v", 0.0)),
            "is_closed": bool(kline.get("x", False)),
        }
        self.cache.set_latest(symbol, event)
        self.socketio.emit("price_update", event, room=f"symbol:{symbol}")

        if event["is_closed"]:
            self._upsert_candle(event)
            candles = self.latest_candles(symbol, limit=220)
            analysis = self.market_service.build_analysis(symbol, candles)
            self.alert_engine.evaluate(symbol, event["close"], analysis["indicators"])
            self.socketio.emit(
                "analysis_update",
                {"symbol": symbol, **analysis},
                room=f"symbol:{symbol}",
            )

    def _upsert_candle(self, event: dict):
        candle = PriceCandle.query.filter_by(symbol=event["symbol"], open_time=event["open_time"]).first()
        if candle is None:
            candle = PriceCandle(symbol=event["symbol"], open_time=event["open_time"])
            db.session.add(candle)
        candle.close_time = event["close_time"]
        candle.open = event["open"]
        candle.high = event["high"]
        candle.low = event["low"]
        candle.close = event["close"]
        candle.volume = event["volume"]
        candle.is_closed = True
        db.session.commit()

    def latest_candles(self, symbol: str, limit: int = 300) -> list[dict]:
        rows = (
            PriceCandle.query.filter_by(symbol=symbol.upper(), is_closed=True)
            .order_by(PriceCandle.open_time.desc())
            .limit(limit)
            .all()
        )
        if rows:
            rows = list(reversed(rows))
            return [
                {
                    "open_time": r.open_time,
                    "open": r.open,
                    "high": r.high,
                    "low": r.low,
                    "close": r.close,
                    "volume": r.volume,
                    "close_time": r.close_time,
                }
                for r in rows
            ]
        fetched = self.market_service.fetch_historical_klines(symbol, limit=limit)
        return fetched


def default_watchlist_for_user(user_id: int) -> list[str]:
    rows = WatchlistItem.query.filter_by(user_id=user_id).order_by(WatchlistItem.created_at.asc()).all()
    return [r.symbol for r in rows]
