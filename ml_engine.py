import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["sma_20"] = out["close"].rolling(window=20, min_periods=20).mean()
    out["ema_20"] = out["close"].ewm(span=20, adjust=False).mean()

    delta = out["close"].diff()
    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)
    avg_gain = gains.rolling(window=14, min_periods=14).mean()
    avg_loss = losses.rolling(window=14, min_periods=14).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out["rsi_14"] = 100 - (100 / (1 + rs))

    ema_fast = out["close"].ewm(span=12, adjust=False).mean()
    ema_slow = out["close"].ewm(span=26, adjust=False).mean()
    out["macd"] = ema_fast - ema_slow
    out["macd_signal"] = out["macd"].ewm(span=9, adjust=False).mean()
    out["macd_hist"] = out["macd"] - out["macd_signal"]

    out["vol_sma_20"] = out["volume"].rolling(window=20, min_periods=20).mean()
    out["ret_1"] = out["close"].pct_change(1)
    out["ret_3"] = out["close"].pct_change(3)
    out["ret_5"] = out["close"].pct_change(5)
    return out


class PredictionEngine:
    def __init__(self):
        self.features = [
            "close",
            "volume",
            "sma_20",
            "ema_20",
            "rsi_14",
            "macd",
            "macd_signal",
            "macd_hist",
            "vol_sma_20",
            "ret_1",
            "ret_3",
            "ret_5",
        ]

    def _build_dataset(self, df: pd.DataFrame) -> pd.DataFrame:
        data = compute_indicators(df)
        data["target_next_close"] = data["close"].shift(-1)
        data = data.dropna(subset=self.features + ["target_next_close"])
        return data

    def predict_next_close(self, df: pd.DataFrame) -> dict:
        if df.empty or len(df) < 120:
            return {
                "predicted_close": None,
                "direction": "Neutral",
                "confidence": 0.0,
                "model_r2": None,
                "mae": None,
            }

        dataset = self._build_dataset(df)
        if len(dataset) < 80:
            return {
                "predicted_close": None,
                "direction": "Neutral",
                "confidence": 0.0,
                "model_r2": None,
                "mae": None,
            }

        x = dataset[self.features]
        y = dataset["target_next_close"]
        x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=0.2, shuffle=False)
        x_train_arr = x_train.values
        x_test_arr = x_test.values

        model = RandomForestRegressor(
            n_estimators=250,
            max_depth=12,
            min_samples_split=4,
            min_samples_leaf=2,
            random_state=42,
            n_jobs=-1,
        )
        model.fit(x_train_arr, y_train)

        y_pred = model.predict(x_test_arr)
        mae = float(mean_absolute_error(y_test, y_pred))
        r2 = float(r2_score(y_test, y_pred)) if len(y_test) > 1 else None

        latest_row = dataset[self.features].iloc[[-1]].values
        tree_preds = np.array([tree.predict(latest_row)[0] for tree in model.estimators_], dtype=float)
        pred = float(tree_preds.mean())
        pred_std = float(tree_preds.std())
        latest_close = float(df["close"].iloc[-1])
        direction = "Bullish" if pred > latest_close else "Bearish"

        # Confidence favors low uncertainty and positive model fit.
        uncertainty_component = max(0.0, 1.0 - (pred_std / max(latest_close * 0.005, 1e-8)))
        fit_component = 0.5 if r2 is None else max(0.0, min(1.0, (r2 + 1.0) / 2.0))
        confidence = round(float((uncertainty_component * 0.6 + fit_component * 0.4) * 100), 2)

        return {
            "predicted_close": round(pred, 4),
            "direction": direction,
            "confidence": confidence,
            "model_r2": None if r2 is None else round(r2, 4),
            "mae": round(mae, 6),
        }


def summarize_market_state(df: pd.DataFrame) -> dict:
    if df.empty:
        return {
            "trend": "Neutral",
            "rsi": 50.0,
            "sma_20": 0.0,
            "ema_20": 0.0,
            "macd": 0.0,
            "macd_signal": 0.0,
            "volume": 0.0,
            "volume_ratio": 1.0,
        }

    enriched = compute_indicators(df).dropna(subset=["sma_20", "ema_20", "rsi_14", "macd", "macd_signal"])
    if enriched.empty:
        return {
            "trend": "Neutral",
            "rsi": 50.0,
            "sma_20": 0.0,
            "ema_20": 0.0,
            "macd": 0.0,
            "macd_signal": 0.0,
            "volume": float(df["volume"].iloc[-1]),
            "volume_ratio": 1.0,
        }

    last = enriched.iloc[-1]
    trend = "Bullish" if float(last["close"]) > float(last["sma_20"]) else "Bearish"
    vol_ratio = 1.0
    if not np.isnan(last["vol_sma_20"]) and float(last["vol_sma_20"]) > 0:
        vol_ratio = float(last["volume"]) / float(last["vol_sma_20"])

    return {
        "trend": trend,
        "rsi": round(float(last["rsi_14"]), 2),
        "sma_20": round(float(last["sma_20"]), 4),
        "ema_20": round(float(last["ema_20"]), 4),
        "macd": round(float(last["macd"]), 6),
        "macd_signal": round(float(last["macd_signal"]), 6),
        "volume": round(float(last["volume"]), 4),
        "volume_ratio": round(vol_ratio, 2),
    }
