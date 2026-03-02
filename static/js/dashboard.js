const socket = window.io ? io({ transports: ["websocket", "polling"] }) : null;
let currentSymbol = window.MP.defaultSymbol;
let currentInterval = "15m";
let candleBuffer = [];
let paperBalance = 10000;
const paperPortfolio = {};
const tradeJournal = [];
let toolStatusTimer = null;

const settings = loadIndicatorSettings();
applySettingsToInputs();
loadPracticeState();
applyPracticeInputs();

function loadIndicatorSettings() {
    const defaults = {
        emaPeriod: 20,
        smaPeriod: 50,
        rsiPeriod: 14,
        emaEnabled: true,
        smaEnabled: true,
        rsiEnabled: true,
        macdEnabled: true,
    };
    try {
        const raw = localStorage.getItem("mp_indicator_settings");
        if (!raw) return defaults;
        return { ...defaults, ...JSON.parse(raw) };
    } catch {
        return defaults;
    }
}

function loadPracticeState() {
    try {
        const raw = localStorage.getItem("mp_practice_state");
        if (!raw) return;
        const saved = JSON.parse(raw);
        const balance = Number(saved.paperBalance);
        if (Number.isFinite(balance) && balance >= 0) paperBalance = balance;
        const portfolio = saved.paperPortfolio || {};
        Object.keys(portfolio).forEach(symbol => {
            paperPortfolio[symbol] = normalizePosition(portfolio[symbol]);
        });
        (saved.tradeJournal || []).slice(0, 80).forEach(item => tradeJournal.push(item));
    } catch {
        // Ignore corrupt browser state.
    }
}

function persistPracticeState() {
    localStorage.setItem(
        "mp_practice_state",
        JSON.stringify({
            paperBalance,
            paperPortfolio,
            tradeJournal: tradeJournal.slice(0, 80),
        })
    );
}

function loadPracticeConfig() {
    const defaults = { riskPct: 1, slPct: 1.5, tpPct: 3, protectedMode: true };
    try {
        const raw = localStorage.getItem("mp_practice_config");
        if (!raw) return defaults;
        return { ...defaults, ...JSON.parse(raw) };
    } catch {
        return defaults;
    }
}

function applyPracticeInputs() {
    const cfg = loadPracticeConfig();
    const riskNode = document.getElementById("practice-risk-pct");
    const slNode = document.getElementById("practice-sl-pct");
    const tpNode = document.getElementById("practice-tp-pct");
    const protectedNode = document.getElementById("protected-mode");
    if (riskNode) riskNode.value = cfg.riskPct;
    if (slNode) slNode.value = cfg.slPct;
    if (tpNode) tpNode.value = cfg.tpPct;
    if (protectedNode) protectedNode.checked = !!cfg.protectedMode;
}

function savePracticeConfig() {
    const riskNode = document.getElementById("practice-risk-pct");
    const slNode = document.getElementById("practice-sl-pct");
    const tpNode = document.getElementById("practice-tp-pct");
    const protectedNode = document.getElementById("protected-mode");
    if (!riskNode || !slNode || !tpNode || !protectedNode) return;
    localStorage.setItem(
        "mp_practice_config",
        JSON.stringify({
            riskPct: Number(riskNode.value || 1),
            slPct: Number(slNode.value || 1.5),
            tpPct: Number(tpNode.value || 3),
            protectedMode: protectedNode.checked,
        })
    );
}

function normalizePosition(row) {
    const source = row || {};
    const slValue = source.sl === null || source.sl === undefined ? null : Number(source.sl);
    const tpValue = source.tp === null || source.tp === undefined ? null : Number(source.tp);
    return {
        qty: Number(source.qty) || 0,
        avg: Number(source.avg) || 0,
        sl: Number.isFinite(slValue) ? slValue : null,
        tp: Number.isFinite(tpValue) ? tpValue : null,
    };
}

function getPracticeInputs() {
    const riskNode = document.getElementById("practice-risk-pct");
    const slNode = document.getElementById("practice-sl-pct");
    const tpNode = document.getElementById("practice-tp-pct");
    const protectedNode = document.getElementById("protected-mode");
    if (!riskNode || !slNode || !tpNode || !protectedNode) {
        return { riskPct: 1, slPct: 1.5, tpPct: 3, protectedMode: true };
    }
    const riskPct = Math.min(5, Math.max(0.1, Number(riskNode.value || 1)));
    const slPct = Math.min(10, Math.max(0.1, Number(slNode.value || 1.5)));
    const tpPct = Math.min(30, Math.max(0.1, Number(tpNode.value || 3)));
    const protectedMode = protectedNode.checked;
    return { riskPct, slPct, tpPct, protectedMode };
}

function computeSuggestedQty(priceValue) {
    if (!Number.isFinite(priceValue) || priceValue <= 0) return 0;
    const cfg = getPracticeInputs();
    const riskAmount = paperBalance * (cfg.riskPct / 100);
    const unitRisk = priceValue * (cfg.slPct / 100);
    if (!Number.isFinite(unitRisk) || unitRisk <= 0) return 0;
    const maxAffordable = paperBalance / priceValue;
    return Math.max(0, Math.min(riskAmount / unitRisk, maxAffordable));
}

function setToolStatus(message) {
    const node = document.getElementById("tool-status");
    if (!node) return;
    node.textContent = message;
    if (toolStatusTimer) clearTimeout(toolStatusTimer);
    toolStatusTimer = setTimeout(() => {
        node.textContent = "Live Terminal";
    }, 1800);
}

function copyTextFallback(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "absolute";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    try {
        document.execCommand("copy");
        return true;
    } catch {
        return false;
    } finally {
        document.body.removeChild(area);
    }
}

function copySymbolWithPrice() {
    const price = parseCurrentPrice();
    const payload = `${currentSymbol} ${price ? formatUsd(price) : "Live price unavailable"}`;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(payload)
            .then(() => setToolStatus("Copied symbol + price"))
            .catch(() => setToolStatus(copyTextFallback(payload) ? "Copied symbol + price" : "Copy failed"));
        return;
    }
    setToolStatus(copyTextFallback(payload) ? "Copied symbol + price" : "Copy failed");
}

function cycleTimeframe() {
    const node = document.getElementById("timeframe-select");
    if (!node) return;
    const list = Array.from(node.options).map(o => o.value);
    const idx = Math.max(0, list.indexOf(currentInterval));
    const next = list[(idx + 1) % list.length];
    node.value = next;
    node.dispatchEvent(new Event("change", { bubbles: true }));
    setToolStatus(`Timeframe: ${next}`);
}

function resetIndicatorSettings() {
    Object.assign(settings, {
        emaPeriod: 20,
        smaPeriod: 50,
        rsiPeriod: 14,
        emaEnabled: true,
        smaEnabled: true,
        rsiEnabled: true,
        macdEnabled: true,
    });
    localStorage.setItem("mp_indicator_settings", JSON.stringify(settings));
    applySettingsToInputs();
    buildChart();
    drawTradeMiniChart();
    setToolStatus("Indicators reset");
}

function resetDemoAccount() {
    const ok = window.confirm("Reset demo account balance, positions, and journal?");
    if (!ok) return;
    paperBalance = 10000;
    Object.keys(paperPortfolio).forEach(symbol => delete paperPortfolio[symbol]);
    tradeJournal.splice(0, tradeJournal.length);
    persistPracticeState();
    renderTradeJournal();
    updateTradeTicket(parseCurrentPrice());
    setToolStatus("Demo account reset");
}

function resetChartZoom() {
    if (!window.Plotly) {
        setToolStatus("Chart engine unavailable");
        return;
    }
    Plotly.relayout("trading-chart", {
        "xaxis.autorange": true,
        "yaxis.autorange": true,
        "yaxis2.autorange": true,
        "yaxis3.autorange": true,
        "yaxis4.autorange": true,
    }).then(() => setToolStatus("Chart zoom reset"))
        .catch(() => setToolStatus("Unable to reset zoom"));
}

function createQuickAlert() {
    const price = parseCurrentPrice();
    if (!price) {
        setToolStatus("Wait for live price");
        return;
    }
    const threshold = Number((price * 1.003).toFixed(4));
    fetch("/api/alerts/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: currentSymbol, rule_type: "price_above", threshold }),
    }).then(r => {
        if (!r.ok) throw new Error("create alert failed");
        const typeNode = document.getElementById("alert-type");
        const thresholdNode = document.getElementById("alert-threshold");
        if (typeNode) typeNode.value = "price_above";
        if (thresholdNode) thresholdNode.value = threshold.toString();
        refreshAlertLogs();
        setToolStatus("Quick alert created");
    }).catch(() => setToolStatus("Alert creation failed"));
}

function initToolRail() {
    document.querySelectorAll(".tool-rail [data-tool]").forEach(btn => {
        btn.addEventListener("click", () => {
            const action = btn.dataset.tool;
            if (action === "reset-zoom") resetChartZoom();
            else if (action === "copy-symbol") copySymbolWithPrice();
            else if (action === "cycle-timeframe") cycleTimeframe();
            else if (action === "reset-indicators") resetIndicatorSettings();
            else if (action === "open-portfolio") setActiveTab("portfolio");
            else if (action === "open-news") setActiveTab("news");
            else if (action === "quick-alert") createQuickAlert();
            else if (action === "reset-demo") resetDemoAccount();
        });
    });
}

function saveIndicatorSettings() {
    settings.emaPeriod = Number(document.getElementById("set-ema-period").value) || 20;
    settings.smaPeriod = Number(document.getElementById("set-sma-period").value) || 50;
    settings.rsiPeriod = Number(document.getElementById("set-rsi-period").value) || 14;
    settings.emaEnabled = document.getElementById("set-ema-enabled").checked;
    settings.smaEnabled = document.getElementById("set-sma-enabled").checked;
    settings.rsiEnabled = document.getElementById("set-rsi-enabled").checked;
    localStorage.setItem("mp_indicator_settings", JSON.stringify(settings));
}

function applySettingsToInputs() {
    document.getElementById("set-ema-period").value = settings.emaPeriod;
    document.getElementById("set-sma-period").value = settings.smaPeriod;
    document.getElementById("set-rsi-period").value = settings.rsiPeriod;
    document.getElementById("set-ema-enabled").checked = settings.emaEnabled;
    document.getElementById("set-sma-enabled").checked = settings.smaEnabled;
    document.getElementById("set-rsi-enabled").checked = settings.rsiEnabled;
}

function ema(series, period) {
    const out = [];
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < series.length; i += 1) {
        const v = Number(series[i]);
        if (!Number.isFinite(v)) {
            out.push(null);
            continue;
        }
        prev = prev === null ? v : v * k + prev * (1 - k);
        out.push(prev);
    }
    return out;
}

function sma(series, period) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < series.length; i += 1) {
        const v = Number(series[i]) || 0;
        sum += v;
        if (i >= period) sum -= Number(series[i - period]) || 0;
        out.push(i >= period - 1 ? sum / period : null);
    }
    return out;
}

function rsi(series, period) {
    const out = new Array(series.length).fill(null);
    if (series.length <= period) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i += 1) {
        const delta = series[i] - series[i - 1];
        if (delta >= 0) gain += delta;
        else loss -= delta;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < series.length; i += 1) {
        const delta = series[i] - series[i - 1];
        const up = delta > 0 ? delta : 0;
        const down = delta < 0 ? -delta : 0;
        avgGain = (avgGain * (period - 1) + up) / period;
        avgLoss = (avgLoss * (period - 1) + down) / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
}

function macd(series) {
    const fast = ema(series, 12);
    const slow = ema(series, 26);
    const macdLine = fast.map((v, i) => (v === null || slow[i] === null ? null : v - slow[i]));
    const signal = ema(macdLine.map(v => (v === null ? 0 : v)), 9);
    const hist = macdLine.map((v, i) => (v === null || signal[i] === null ? null : v - signal[i]));
    return { macdLine, signal, hist };
}

function formatUsd(value) {
    const n = Number(value || 0);
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function setCurrentSymbolUI(symbol) {
    document.getElementById("symbol-title").textContent = symbol;
    document.getElementById("trade-symbol").value = symbol;
    const pill = document.getElementById("chart-symbol-pill");
    if (pill) pill.textContent = symbol;
}

function getCurrentPosition() {
    if (!paperPortfolio[currentSymbol]) {
        paperPortfolio[currentSymbol] = normalizePosition({ qty: 0, avg: 0, sl: null, tp: null });
    }
    return normalizePosition(paperPortfolio[currentSymbol]);
}

function setCurrentPosition(position) {
    paperPortfolio[currentSymbol] = normalizePosition(position);
    persistPracticeState();
}

function setCoachMessage(message, tone = "neutral") {
    const node = document.getElementById("coach-msg");
    if (!node) return;
    node.textContent = message;
    node.classList.remove("coach-good", "coach-warn");
    if (tone === "good") node.classList.add("coach-good");
    if (tone === "warn") node.classList.add("coach-warn");
}

function addJournalEntry(entry) {
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    tradeJournal.unshift({ ts: stamp, ...entry });
    if (tradeJournal.length > 80) tradeJournal.pop();
    renderTradeJournal();
    persistPracticeState();
}

function renderTradeJournal() {
    const node = document.getElementById("trade-journal");
    if (!node) return;
    node.innerHTML = "";
    if (!tradeJournal.length) {
        const li = document.createElement("li");
        li.innerHTML = `<div class="journal-note">No trades yet. Start with small size and follow suggested qty.</div>`;
        node.appendChild(li);
        return;
    }
    tradeJournal.slice(0, 20).forEach(item => {
        const li = document.createElement("li");
        const pnlClass = Number(item.pnl || 0) >= 0 ? "pos" : "neg";
        const pnlText = item.pnl === null || item.pnl === undefined ? "-" : formatUsd(item.pnl);
        li.innerHTML = `
            <div class="journal-meta">
                <strong>${item.side} ${item.qty} ${item.symbol}</strong>
                <span>${item.ts}</span>
            </div>
            <div class="journal-note">${item.note}</div>
            <div class="journal-meta">
                <span>Price ${item.price}</span>
                <span class="${pnlClass}">Realized P/L: ${pnlText}</span>
            </div>
        `;
        node.appendChild(li);
    });
}

function evaluatePracticeProtection(priceValue) {
    if (!Number.isFinite(priceValue)) return;
    const cfg = getPracticeInputs();
    if (!cfg.protectedMode) return;
    const position = getCurrentPosition();
    if (position.qty <= 0 || !position.sl || !position.tp) return;

    const hitStop = priceValue <= position.sl;
    const hitTarget = priceValue >= position.tp;
    if (!hitStop && !hitTarget) return;

    const exitReason = hitStop ? "Auto stop-loss triggered." : "Auto take-profit triggered.";
    const realized = (priceValue - position.avg) * position.qty;
    paperBalance += position.qty * priceValue;
    addJournalEntry({
        side: "AUTO EXIT",
        symbol: currentSymbol,
        qty: position.qty.toFixed(4),
        price: Number(priceValue).toFixed(2),
        pnl: realized,
        note: `${exitReason} Protected trade closed automatically.`,
    });
    setCurrentPosition({ qty: 0, avg: 0, sl: null, tp: null });
}

function updateTradeTicket(price) {
    const priceValue = Number(price);
    const qtyInput = Number(document.getElementById("trade-qty").value || 0);
    const cfg = getPracticeInputs();
    const position = getCurrentPosition();
    const invested = position.qty * position.avg;
    const markValue = Number.isFinite(priceValue) ? position.qty * priceValue : 0;
    const pnl = markValue - invested;
    const rr = cfg.slPct > 0 ? cfg.tpPct / cfg.slPct : 0;
    const suggestedQty = computeSuggestedQty(priceValue);

    document.getElementById("paper-balance-chip").textContent = formatUsd(paperBalance);
    const quickBalanceNode = document.getElementById("quick-balance");
    if (quickBalanceNode) quickBalanceNode.textContent = formatUsd(paperBalance);
    document.getElementById("trade-current-price").textContent = Number.isFinite(priceValue) ? formatUsd(priceValue) : "$0.00";
    document.getElementById("trade-investment").textContent = formatUsd(qtyInput * (Number.isFinite(priceValue) ? priceValue : 0));
    document.getElementById("trade-margin").textContent = formatUsd(paperBalance);
    document.getElementById("trade-pnl").textContent = formatUsd(pnl);
    document.getElementById("pos-qty").textContent = position.qty.toFixed(4);
    document.getElementById("pos-entry").textContent = position.avg ? position.avg.toFixed(2) : "0.00";
    document.getElementById("pos-market").textContent = Number.isFinite(priceValue) ? priceValue.toFixed(2) : "0.00";
    document.getElementById("pos-pnl").textContent = formatUsd(pnl);
    document.getElementById("pos-value").textContent = formatUsd(markValue);
    const posSl = document.getElementById("pos-sl");
    const posTp = document.getElementById("pos-tp");
    if (posSl) posSl.textContent = position.sl ? formatUsd(position.sl) : "-";
    if (posTp) posTp.textContent = position.tp ? formatUsd(position.tp) : "-";
    document.getElementById("position-text").textContent = `Position: ${position.qty.toFixed(4)} ${currentSymbol}`;
    const rrNode = document.getElementById("rr-value");
    const suggestedNode = document.getElementById("recommended-qty");
    if (rrNode) rrNode.textContent = rr.toFixed(2);
    if (suggestedNode) suggestedNode.textContent = suggestedQty.toFixed(4);

    document.getElementById("trade-pnl").className = pnl >= 0 ? "pos" : "neg";
    document.getElementById("pos-pnl").className = pnl >= 0 ? "pos" : "neg";

    if (cfg.riskPct > 2) {
        setCoachMessage("Risk above 2% is aggressive for beginners. Lower risk to 1-2%.", "warn");
    } else if (qtyInput > suggestedQty * 1.25 && suggestedQty > 0) {
        setCoachMessage("Current quantity is high versus suggested risk size. Reduce lot size.", "warn");
    } else if (rr < 1.2) {
        setCoachMessage("Reward-to-risk is low. Consider take-profit at least 1.5x stop-loss.", "warn");
    } else {
        setCoachMessage("Good setup. Risk is controlled and position size is beginner-friendly.", "good");
    }
}

function buildChart() {
    if (!candleBuffer.length) {
        Plotly.newPlot("trading-chart", [], { paper_bgcolor: "rgba(0,0,0,0)" });
        return;
    }

    const x = candleBuffer.map(c => new Date(c.open_time));
    const open = candleBuffer.map(c => Number(c.open));
    const high = candleBuffer.map(c => Number(c.high));
    const low = candleBuffer.map(c => Number(c.low));
    const close = candleBuffer.map(c => Number(c.close));
    const volume = candleBuffer.map(c => Number(c.volume));
    const volumeColors = candleBuffer.map(c => (Number(c.close) >= Number(c.open) ? "#1fcf7a99" : "#ff657799"));
    const rsiValues = settings.rsiEnabled ? rsi(close, settings.rsiPeriod) : [];
    const macdData = settings.macdEnabled ? macd(close) : null;
    const lastRsi = rsiValues.length ? rsiValues[rsiValues.length - 1] : null;
    const lastMacd = macdData && macdData.macdLine.length ? macdData.macdLine[macdData.macdLine.length - 1] : null;
    const lastSignal = macdData && macdData.signal.length ? macdData.signal[macdData.signal.length - 1] : null;

    const traces = [
        {
            x,
            open,
            high,
            low,
            close,
            type: "candlestick",
            name: "Price",
            increasing: { line: { color: "#28d179" } },
            decreasing: { line: { color: "#ff5f6d" } },
            xaxis: "x",
            yaxis: "y",
            showlegend: false,
        },
        {
            x,
            y: volume,
            type: "bar",
            name: "Volume",
            marker: { color: volumeColors },
            xaxis: "x",
            yaxis: "y2",
            showlegend: false,
        },
    ];

    if (settings.emaEnabled) {
        traces.push({
            x,
            y: ema(close, settings.emaPeriod),
            mode: "lines",
            line: { color: "#f8b84a", width: 1.8 },
            name: `EMA ${settings.emaPeriod}`,
            xaxis: "x",
            yaxis: "y",
            showlegend: false,
        });
    }

    if (settings.smaEnabled) {
        traces.push({
            x,
            y: sma(close, settings.smaPeriod),
            mode: "lines",
            line: { color: "#2d8cff", width: 1.8 },
            name: `SMA ${settings.smaPeriod}`,
            xaxis: "x",
            yaxis: "y",
            showlegend: false,
        });
    }

    if (settings.rsiEnabled) {
        traces.push(
            { x, y: rsiValues, mode: "lines", line: { color: "#b66dff", width: 1.5 }, name: "RSI", xaxis: "x", yaxis: "y3", showlegend: false },
            { x: [x[0], x[x.length - 1]], y: [70, 70], mode: "lines", line: { color: "#6f7ca0", width: 1, dash: "dot" }, hoverinfo: "skip", showlegend: false, xaxis: "x", yaxis: "y3" },
            { x: [x[0], x[x.length - 1]], y: [50, 50], mode: "lines", line: { color: "#6f7ca0", width: 1, dash: "dot" }, hoverinfo: "skip", showlegend: false, xaxis: "x", yaxis: "y3" }
        );
    }

    if (settings.macdEnabled) {
        traces.push(
            { x, y: macdData.hist, type: "bar", marker: { color: macdData.hist.map(v => (v >= 0 ? "#2d8cff99" : "#ff5f6d99")) }, name: "MACD Hist", xaxis: "x", yaxis: "y4", showlegend: false },
            { x, y: macdData.macdLine, mode: "lines", line: { color: "#2d8cff", width: 1.4 }, name: "MACD", xaxis: "x", yaxis: "y4", showlegend: false },
            { x, y: macdData.signal, mode: "lines", line: { color: "#f8b84a", width: 1.4 }, name: "Signal", xaxis: "x", yaxis: "y4", showlegend: false }
        );
    }

    const annotations = [];
    if (settings.rsiEnabled) {
        annotations.push({
            text: `RSI ${settings.rsiPeriod}${lastRsi !== null ? `  ${lastRsi.toFixed(2)}` : ""}`,
            xref: "paper",
            yref: "paper",
            x: 0.01,
            y: 0.352,
            showarrow: false,
            font: { size: 12, color: "#b66dff" },
        });
    }
    if (settings.macdEnabled) {
        const histValue = lastMacd !== null && lastSignal !== null ? lastMacd - lastSignal : null;
        annotations.push({
            text: `MACD 12 26 9${histValue !== null ? `  ${histValue.toFixed(2)}` : ""}`,
            xref: "paper",
            yref: "paper",
            x: 0.01,
            y: 0.185,
            showarrow: false,
            font: { size: 12, color: "#f8b84a" },
        });
    }

    Plotly.react(
        "trading-chart",
        traces,
        {
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)",
            margin: { l: 50, r: 72, t: 10, b: 20 },
            font: { color: "#d7e6ff", size: 12 },
            showlegend: false,
            annotations,
            xaxis: { gridcolor: "#1c315d", rangeslider: { visible: false }, showticklabels: false, tickfont: { size: 12 } },
            yaxis: {
                domain: [0.50, 1],
                gridcolor: "#1c315d",
                side: "right",
                automargin: true,
                tickfont: { size: 14 },
            },
            yaxis2: {
                domain: [0.39, 0.48],
                gridcolor: "#1c315d",
                side: "right",
                showticklabels: false,
                automargin: true,
                tickfont: { size: 12 },
            },
            yaxis3: {
                domain: [0.22, 0.36],
                gridcolor: "#1c315d",
                side: "right",
                range: [0, 100],
                tickmode: "array",
                tickvals: [30, 50, 70],
                automargin: true,
                tickfont: { size: 11 },
            },
            yaxis4: {
                domain: [0.05, 0.19],
                gridcolor: "#1c315d",
                side: "right",
                zerolinecolor: "#42669f",
                tickmode: "array",
                tickvals: [0],
                automargin: true,
                tickfont: { size: 12 },
            },
        },
        { responsive: true, displayModeBar: false }
    );
}

function drawTradeMiniChart() {
    const node = document.getElementById("trade-mini-chart");
    if (!node || !candleBuffer.length) return;
    const sample = candleBuffer.slice(-80);
    const x = sample.map(c => new Date(c.open_time));
    const close = sample.map(c => Number(c.close));
    Plotly.react(
        "trade-mini-chart",
        [
            { x, y: close, mode: "lines", line: { color: "#2fd07f", width: 1.5 }, name: "Price" },
            { x, y: ema(close, 10), mode: "lines", line: { color: "#f7b64b", width: 1.2 }, name: "EMA 10" },
            { x, y: ema(close, 24), mode: "lines", line: { color: "#3b8eff", width: 1.2 }, name: "EMA 24" },
        ],
        {
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)",
            margin: { l: 8, r: 8, t: 6, b: 6 },
            xaxis: { visible: false },
            yaxis: { visible: false },
            showlegend: false,
        },
        { displayModeBar: false, responsive: true }
    );
}

function fillIndicators(ind) {
    document.getElementById("m-rsi").textContent = ind.rsi ?? "-";
    document.getElementById("m-sma").textContent = ind.sma_20 ?? "-";
    document.getElementById("m-ema").textContent = ind.ema_20 ?? "-";
    document.getElementById("m-macd").textContent = ind.macd ?? "-";
    document.getElementById("trend-chip").textContent = `Trend: ${ind.trend || "-"}`;
}

function fillPrediction(pred) {
    const direction = (pred.direction || "Neutral").toString();
    const confidence = Number(pred.confidence);
    const predictedClose = Number(pred.predicted_close);
    const modelR2 = Number(pred.model_r2);
    const mae = Number(pred.mae);

    const directionNode = document.getElementById("p-direction");
    const confidenceNode = document.getElementById("p-confidence");
    const nextCloseNode = document.getElementById("p-next-close");
    const signalNode = document.getElementById("p-signal-strength");
    const r2Node = document.getElementById("p-model-r2");
    const maeNode = document.getElementById("p-mae");
    const actionNode = document.getElementById("p-action");
    const confidenceFill = document.getElementById("p-confidence-fill");

    if (directionNode) {
        directionNode.textContent = direction || "-";
        directionNode.classList.remove("prediction-bull", "prediction-bear", "prediction-neutral");
        if (direction === "Bullish") directionNode.classList.add("prediction-bull");
        else if (direction === "Bearish") directionNode.classList.add("prediction-bear");
        else directionNode.classList.add("prediction-neutral");
    }

    if (confidenceNode) {
        confidenceNode.textContent = Number.isFinite(confidence) ? `${confidence.toFixed(1)}%` : "-";
    }

    if (confidenceFill) {
        const pct = Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 0;
        confidenceFill.style.width = `${pct}%`;
    }

    if (nextCloseNode) nextCloseNode.textContent = Number.isFinite(predictedClose) ? formatUsd(predictedClose) : "-";
    if (r2Node) r2Node.textContent = Number.isFinite(modelR2) ? modelR2.toFixed(3) : "N/A";
    if (maeNode) maeNode.textContent = Number.isFinite(mae) ? mae.toFixed(4) : "N/A";

    let signal = "Low";
    if (Number.isFinite(confidence) && confidence >= 75) signal = "High";
    else if (Number.isFinite(confidence) && confidence >= 55) signal = "Medium";
    if (signalNode) signalNode.textContent = signal;

    let action = "Action: Wait for clearer setup";
    if (direction === "Bullish" && Number.isFinite(confidence) && confidence >= 60) {
        action = "Action: Long bias on pullbacks";
    } else if (direction === "Bearish" && Number.isFinite(confidence) && confidence >= 60) {
        action = "Action: Short bias on rallies";
    } else if (direction === "Neutral") {
        action = "Action: Sideways market, reduce size";
    }
    if (actionNode) actionNode.textContent = action;
}

function fillNews(news) {
    document.getElementById("news-label").textContent = `Market sentiment: ${news.label || "Neutral"} (${news.score ?? 0})`;
    const node = document.getElementById("news-list");
    node.innerHTML = "";
    (news.articles || []).forEach(item => {
        const li = document.createElement("li");
        li.innerHTML = `<a href="${item.url}" target="_blank" rel="noopener">${item.title || "Untitled"}</a>`;
        node.appendChild(li);
    });
}

function fillAlertLogs(logs) {
    const node = document.getElementById("alerts-log");
    node.innerHTML = "";
    (logs || []).slice(0, 8).forEach(item => {
        const li = document.createElement("li");
        li.textContent = item.message || `${item.symbol}: alert triggered`;
        node.appendChild(li);
    });
}

function updateLivePrice(price) {
    const n = Number(price);
    document.getElementById("live-price-chip").textContent = Number.isFinite(n) ? `$${n.toFixed(2)}` : "Connecting...";
    const quickPriceNode = document.getElementById("quick-price");
    if (quickPriceNode) quickPriceNode.textContent = Number.isFinite(n) ? formatUsd(n) : "$0.00";
    evaluatePracticeProtection(n);
    updateTradeTicket(n);
}

function renderWatchlist(items) {
    const node = document.getElementById("watchlist-list");
    node.innerHTML = "";
    (items || []).forEach(row => {
        const li = document.createElement("li");
        li.dataset.symbol = row.symbol;
        li.className = row.symbol === currentSymbol ? "active" : "";
        const cls = row.change_pct >= 0 ? "pos" : "neg";
        const sign = row.change_pct >= 0 ? "+" : "";
        li.innerHTML = `${row.symbol}<span class="${cls}">${row.price.toFixed(2)} ${sign}${row.change_pct}%</span>`;
        li.addEventListener("click", () => {
            currentSymbol = row.symbol;
            document.getElementById("symbol-select").value = currentSymbol;
            setCurrentSymbolUI(currentSymbol);
            subscribeSocket();
            bootstrap();
        });
        node.appendChild(li);
    });
}

function parseCurrentPrice() {
    const txt = document.getElementById("live-price-chip").textContent || "";
    const num = Number(txt.replace("$", "").replace(/,/g, "").trim());
    return Number.isFinite(num) ? num : null;
}

function executeTrade(side) {
    const qty = Number(document.getElementById("trade-qty").value || 0);
    const price = parseCurrentPrice();
    if (!price || qty <= 0) return;
    const cfg = getPracticeInputs();
    const position = getCurrentPosition();

    if (side === "buy") {
        const cost = qty * price;
        if (cost > paperBalance) {
            setCoachMessage("Insufficient demo balance for this order size.", "warn");
            return;
        }
        const newQty = position.qty + qty;
        const newAvg = newQty > 0 ? ((position.avg * position.qty) + (price * qty)) / newQty : 0;
        paperBalance -= cost;
        const next = {
            qty: newQty,
            avg: newAvg,
            sl: cfg.protectedMode ? newAvg * (1 - cfg.slPct / 100) : null,
            tp: cfg.protectedMode ? newAvg * (1 + cfg.tpPct / 100) : null,
        };
        setCurrentPosition(next);
        addJournalEntry({
            side: "BUY",
            symbol: currentSymbol,
            qty: qty.toFixed(4),
            price: price.toFixed(2),
            pnl: null,
            note: cfg.protectedMode
                ? `Opened protected position. SL ${formatUsd(next.sl)} | TP ${formatUsd(next.tp)}`
                : "Opened position without protection.",
        });
    } else {
        if (qty > position.qty) {
            setCoachMessage("Sell quantity exceeds current position.", "warn");
            return;
        }
        paperBalance += qty * price;
        const remaining = position.qty - qty;
        const realized = (price - position.avg) * qty;
        setCurrentPosition({
            qty: remaining,
            avg: remaining > 0 ? position.avg : 0,
            sl: remaining > 0 ? position.sl : null,
            tp: remaining > 0 ? position.tp : null,
        });
        addJournalEntry({
            side: "SELL",
            symbol: currentSymbol,
            qty: qty.toFixed(4),
            price: price.toFixed(2),
            pnl: realized,
            note: remaining > 0 ? "Partial close executed." : "Position fully closed.",
        });
    }
    updateTradeTicket(price);
    savePracticeConfig();
    persistPracticeState();
}

function setActiveTab(tabName) {
    document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
    document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.id === `panel-${tabName}`));
}

function subscribeSocket() {
    if (!socket) return;
    socket.emit("subscribe_symbol", { symbol: currentSymbol });
}

function refreshWatchlistSnapshot() {
    fetch("/api/watchlist/snapshot").then(r => r.json()).then(data => renderWatchlist(data.items || []));
}

function refreshAlertLogs() {
    fetch("/api/alerts/logs").then(r => r.json()).then(data => fillAlertLogs(data.logs || []));
}

function bootstrap() {
    fetch(`/api/bootstrap?symbol=${currentSymbol}&interval=${currentInterval}`)
        .then(r => r.json())
        .then(data => {
            candleBuffer = data.candles || [];
            buildChart();
            drawTradeMiniChart();
            const latest = data.latest ? data.latest.close : (candleBuffer.length ? candleBuffer[candleBuffer.length - 1].close : null);
            updateLivePrice(latest);
            fillIndicators((data.analysis || {}).indicators || {});
            fillPrediction((data.analysis || {}).prediction || {});
            fillNews((data.analysis || {}).news || { label: "Neutral", score: 0, articles: [] });
            fillAlertLogs(data.alerts || []);
            if (data.watchlist_snapshot) renderWatchlist(data.watchlist_snapshot);
        })
        .catch(() => {
            document.getElementById("live-price-chip").textContent = "Feed retrying...";
        });
}

document.querySelectorAll(".tab-btn").forEach(btn => btn.addEventListener("click", () => setActiveTab(btn.dataset.tab)));
document.getElementById("btn-open-settings").addEventListener("click", () => setActiveTab("settings"));
document.getElementById("btn-open-trade").addEventListener("click", () => setActiveTab("trade"));

document.getElementById("symbol-select").addEventListener("change", e => {
    currentSymbol = e.target.value;
    setCurrentSymbolUI(currentSymbol);
    subscribeSocket();
    bootstrap();
});

document.getElementById("timeframe-select").addEventListener("change", e => {
    currentInterval = e.target.value;
    subscribeSocket();
    bootstrap();
});

document.getElementById("save-settings").addEventListener("click", () => {
    saveIndicatorSettings();
    buildChart();
    drawTradeMiniChart();
});

document.getElementById("btn-buy").addEventListener("click", () => executeTrade("buy"));
document.getElementById("btn-sell").addEventListener("click", () => executeTrade("sell"));
const quickBuyBtn = document.getElementById("quick-buy");
const quickSellBtn = document.getElementById("quick-sell");
if (quickBuyBtn) quickBuyBtn.addEventListener("click", () => executeTrade("buy"));
if (quickSellBtn) quickSellBtn.addEventListener("click", () => executeTrade("sell"));
document.getElementById("qty-inc").addEventListener("click", () => {
    const node = document.getElementById("trade-qty");
    node.value = (Number(node.value || 0) + 0.01).toFixed(3);
    updateTradeTicket(parseCurrentPrice());
});
document.getElementById("qty-dec").addEventListener("click", () => {
    const node = document.getElementById("trade-qty");
    node.value = Math.max(0.001, Number(node.value || 0) - 0.01).toFixed(3);
    updateTradeTicket(parseCurrentPrice());
});
document.getElementById("trade-qty").addEventListener("input", () => updateTradeTicket(parseCurrentPrice()));
const practiceRiskNode = document.getElementById("practice-risk-pct");
const practiceSlNode = document.getElementById("practice-sl-pct");
const practiceTpNode = document.getElementById("practice-tp-pct");
const protectedModeNode = document.getElementById("protected-mode");
const useSuggestedQtyNode = document.getElementById("use-suggested-qty");
if (practiceRiskNode) {
    practiceRiskNode.addEventListener("input", () => {
        savePracticeConfig();
        updateTradeTicket(parseCurrentPrice());
    });
}
if (practiceSlNode) {
    practiceSlNode.addEventListener("input", () => {
        savePracticeConfig();
        updateTradeTicket(parseCurrentPrice());
    });
}
if (practiceTpNode) {
    practiceTpNode.addEventListener("input", () => {
        savePracticeConfig();
        updateTradeTicket(parseCurrentPrice());
    });
}
if (protectedModeNode) {
    protectedModeNode.addEventListener("change", () => {
        savePracticeConfig();
        updateTradeTicket(parseCurrentPrice());
    });
}
if (useSuggestedQtyNode) {
    useSuggestedQtyNode.addEventListener("click", () => {
        const price = parseCurrentPrice();
        const suggested = computeSuggestedQty(price);
        const node = document.getElementById("trade-qty");
        node.value = Math.max(0.001, suggested).toFixed(4);
        updateTradeTicket(price);
    });
}

document.getElementById("add-watch-btn").addEventListener("click", () => {
    fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: currentSymbol }),
    }).then(refreshWatchlistSnapshot);
});

document.getElementById("create-alert-btn").addEventListener("click", () => {
    const ruleType = document.getElementById("alert-type").value;
    const thresholdRaw = document.getElementById("alert-threshold").value;
    const threshold = thresholdRaw ? Number(thresholdRaw) : null;
    fetch("/api/alerts/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: currentSymbol, rule_type: ruleType, threshold }),
    }).then(() => {
        document.getElementById("alert-threshold").value = "";
        refreshAlertLogs();
    });
});

if (socket) {
    socket.on("connect", () => subscribeSocket());
    socket.on("price_update", event => {
        if (!event || event.symbol !== currentSymbol) return;
        updateLivePrice(event.close);
        if (currentInterval !== "1m" || !event.is_closed) return;
        if (candleBuffer.length && candleBuffer[candleBuffer.length - 1].open_time === event.open_time) {
            candleBuffer[candleBuffer.length - 1] = event;
        } else {
            candleBuffer.push(event);
            if (candleBuffer.length > 320) candleBuffer.shift();
        }
        buildChart();
        drawTradeMiniChart();
    });
    socket.on("analysis_update", payload => {
        if (!payload || payload.symbol !== currentSymbol) return;
        fillIndicators(payload.indicators || {});
        fillPrediction(payload.prediction || {});
        fillNews(payload.news || { label: "Neutral", score: 0, articles: [] });
    });
}

setCurrentSymbolUI(currentSymbol);
setActiveTab(null);
initToolRail();
renderTradeJournal();
updateTradeTicket(parseCurrentPrice());
subscribeSocket();
bootstrap();
refreshWatchlistSnapshot();
refreshAlertLogs();
setInterval(() => {
    bootstrap();
    refreshWatchlistSnapshot();
    refreshAlertLogs();
}, 10000);
