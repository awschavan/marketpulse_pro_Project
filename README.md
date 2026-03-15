# MarketPulse Pro (Professional Flask Dashboard)


Production-style crypto market intelligence platform with:

- Live crypto stream (Binance WebSocket, near real-time)
- Redis-backed latest-price cache (with memory fallback)
- Technical analysis: SMA, EMA, RSI, MACD, volume ratio
- Alert engine: price/RSI/breakout rules + alert logs
- News API sentiment panel
- Advanced ML prediction (RandomForest next-close forecast)
- Login, registration, role-based access, admin panel
- Historical candle storage for backtesting/analytics
- Docker + Nginx + Postgres + Redis deployment files

## Features
- Live crypto stream
- Technical indicators
- Alerts
- Machine learning prediction

## 📸 Screenshots

### 🔐 Login Page
![Login](login.png.jpeg)

### 📊 Dashboard
![Dashboard](dashboard.png.jpeg)

### 🛠 Admin Dashboard
![Admin Dashboard](admin-dashboard.png.jpeg)

### 💹 Trade Page
![Trade Page](trade-page.png.jpeg)

## Project Structure

```
marketpulse_pro/
  app.py
  models.py
  ml_engine.py
  services.py
  requirements.txt
  .env.example
  wsgi.py
  Dockerfile
  docker-compose.yml
  nginx/
    default.conf
  static/
    css/style.css
    js/dashboard.js
  templates/
    base.html
    dashboard.html
    login.html
    register.html
    admin.html
```

## Quick Start (Windows, local)

1. Open terminal in this folder:
   `C:\Users\swapn\OneDrive\Documents\dashboard\marketpulse_pro`

2. Activate your venv:
   ```powershell
   .\venv\Scripts\Activate.ps1
   ```

3. Install dependencies:
   ```powershell
   pip install --no-cache-dir -r .\requirements.txt
   ```

4. Create env file:
   ```powershell
   Copy-Item .env.example .env
   ```

5. Run app:
   ```powershell
   python .\app.py
   ```

6. Open:
   `http://127.0.0.1:5000`

### Default Admin Login

- Username: `admin`
- Password: `Admin@123`

Change this immediately in production.

## Database Setup Options

### Option A: SQLite (fast local dev)

Use in `.env`:

```
DATABASE_URL=sqlite:///marketpulse_pro.db
```

No extra setup required.

### Option B: PostgreSQL (production style)

Use in `.env`:

```
DATABASE_URL=postgresql+psycopg2://marketpulse:marketpulse@localhost:5432/marketpulse
```

Start Postgres via Docker compose (below), then run app.

## Docker Full Stack (App + Redis + Postgres + Nginx)

1. Create `.env` from `.env.example` and set values.
2. Start stack:

```bash
docker compose up --build
```

3. Open:

- App via Nginx: `http://localhost`
- Direct app: `http://localhost:5000`

## News API Sentiment Setup

1. Get API key from NewsAPI.
2. Set in `.env`:

```
NEWS_API_KEY=your_key_here
```

If missing, sentiment gracefully falls back to neutral.

## Alert Notifications (Optional)

### Telegram

Set in `.env`:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### Email

SMTP placeholders are wired and can be extended in `services.py`.

## AWS Deployment Outline

1. EC2: run Docker + Nginx stack.
2. RDS Postgres: update `DATABASE_URL` to RDS endpoint.
3. ElastiCache Redis: update `REDIS_URL`.
4. Route53 + SSL: place cert at load balancer / reverse proxy.

## Notes

- Live stream uses Binance combined kline stream at 1m interval.
- Historical candles persist in `price_candles` table.
- Alert logs persist in `alert_logs` and are visible in dashboard/admin.
- ML prediction uses rolling technical features + RandomForest model.
