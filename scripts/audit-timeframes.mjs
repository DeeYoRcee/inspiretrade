// Timeframe audit: fetch real data for every timeframe via the SAME provider
// configs the app uses, and measure the median spacing between bar opens.
// Binance: BTCUSDT klines. Yahoo: GC=F + EURUSD=X + ^NDX chart API.
const BINANCE_INTERVAL = { "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1h","2h":"2h","4h":"4h","1d":"1d","1W":"1w","1M":"1M" };
const YAHOO_INTERVAL = {
  "1m":{range:"5d",interval:"1m"},"3m":{range:"5d",interval:"1m"},"5m":{range:"1mo",interval:"5m"},
  "15m":{range:"1mo",interval:"15m"},"30m":{range:"1mo",interval:"30m"},"1h":{range:"3mo",interval:"60m"},
  "2h":{range:"3mo",interval:"60m"},"4h":{range:"1y",interval:"60m"},"1d":{range:"2y",interval:"1d"},
  "1W":{range:"5y",interval:"1wk"},"1M":{range:"10y",interval:"1mo"},
};
const EXPECT = { "1m":60,"3m":180,"5m":300,"15m":900,"30m":1800,"1h":3600,"2h":7200,"4h":14400,"1d":86400,"1W":604800,"1M":2592000 };

function median(arr){ if(!arr.length) return 0; const a=[...arr].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; }

function spacingReport(times, expected, label){
  const gaps=[]; for(let i=1;i<times.length;i++){ const g=times[i]-times[i-1]; if(g>0) gaps.push(g); }
  const med=median(gaps);
  const flag = med===expected ? "OK " : (Math.abs(med-expected)<=expected*0.5 ? "ok~" : "BAD");
  // also detect wrong-within-gap clusters: count gaps much smaller than expected
  const tiny = gaps.filter(g=>g<expected*0.4).length;
  console.log(`${flag} ${label.padEnd(24)} bars=${String(times.length).padStart(5)} medianGap=${String(med).padStart(7)}s expected=${expected}s tinyGaps=${tiny}`);
  return { med, expected, bad: med!==expected && Math.abs(med-expected)>expected*0.5 };
}

async function yahooBars(sym, range, interval){
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`;
  const res=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});
  const j=await res.json();
  const r=j?.chart?.result?.[0];
  return r?.timestamp||[];
}

async function main(){
  console.log("== BINANCE BTCUSDT (crypto feed) ==");
  for(const tf of Object.keys(BINANCE_INTERVAL)){
    try{
      const res=await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${BINANCE_INTERVAL[tf]}&limit=500`);
      const raw=await res.json();
      const times=raw.map(k=>Math.floor(k[0]/1000));
      spacingReport(times, EXPECT[tf], `binance ${tf}`);
    }catch(e){ console.log("ERR binance", tf, e.message); }
    await new Promise(r=>setTimeout(r,120));
  }
  for(const sym of ["GC=F","EURUSD=X","^NDX"]){
    console.log(`== YAHOO ${sym} (quotes feed) ==`);
    for(const tf of Object.keys(YAHOO_INTERVAL)){
      try{
        const {range,interval}=YAHOO_INTERVAL[tf];
        const times=await yahooBars(sym,range,interval);
        spacingReport(times, EXPECT[tf], `yahoo ${tf} [${range}/${interval}]`);
      }catch(e){ console.log("ERR yahoo", tf, e.message); }
      await new Promise(r=>setTimeout(r,150));
    }
  }
  // simulate the app's FIXED aggregation: aggregateBars(bars, TF_SECONDS[tf]/60)
  console.log("== APP AGGREGATION SIM (fixed: bucket minutes = tf minutes) ==");
  const aggregate = (times, bucketSec) => {
    const set = new Map();
    for (const t of times) { const b = Math.floor(t / bucketSec) * bucketSec; set.set(b, true); }
    return [...set.keys()].sort((a, b) => a - b);
  };
  for (const tf of ["3m", "2h", "4h"]) {
    const { range, interval } = YAHOO_INTERVAL[tf];
    const times = await yahooBars("EURUSD=X", range, interval);
    const out = aggregate(times, EXPECT[tf]);
    const rep = spacingReport(out, EXPECT[tf], `agg ${tf} [${range}/${interval}]`);
  }
}
main().catch(e=>{console.error(e);process.exit(1)});
