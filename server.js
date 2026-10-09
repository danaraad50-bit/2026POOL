import express from "express";
import cron from "node-cron";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "data/config.json")));
const rosters = JSON.parse(fs.readFileSync(path.join(__dirname, "data/rosters.json")));
const participants = JSON.parse(fs.readFileSync(path.join(__dirname, "data/participants.json")));
const slotOptions = JSON.parse(fs.readFileSync(path.join(__dirname, "data/slot-options.json")));
const PORT = process.env.PORT || 3000;
const API_BASE = process.env.NHL_API_BASE || "https://api.nhle.com/stats/rest/en";
const ADMIN_PASSPHRASE = process.env.ADMIN_PASSPHRASE || "bmo2026admin";

const TEAM_ALIASES = { NJ:"NJD", NJD:"NJD", SJ:"SJS", SJS:"SJS", TB:"TBL", TBL:"TBL", VGK:"VGK", MTL:"MTL", TOR:"TOR", EDM:"EDM", COL:"COL", DAL:"DAL", MIN:"MIN", CAR:"CAR", CHI:"CHI", DET:"DET", ANA:"ANA", NYI:"NYI", NYR:"NYR", BOS:"BOS", BUF:"BUF", FLA:"FLA", LAK:"LAK", NSH:"NSH", OTT:"OTT", PIT:"PIT", STL:"STL", WSH:"WSH", UTA:"UTA", VAN:"VAN", SEA:"SEA", CBJ:"CBJ", WPG:"WPG", CGY:"CGY", PHI:"PHI" };
const TEAM_NAMES = { NJD:"New Jersey", SJS:"San Jose", TBL:"Tampa Bay", VGK:"Vegas", MTL:"Montreal", TOR:"Toronto", EDM:"Edmonton", COL:"Colorado", DAL:"Dallas", MIN:"Minnesota", CAR:"Carolina", CHI:"Chicago", DET:"Detroit", ANA:"Anaheim", NYI:"NY Islanders", NYR:"NY Rangers", BOS:"Boston", BUF:"Buffalo", FLA:"Florida", LAK:"Los Angeles", NSH:"Nashville", OTT:"Ottawa", PIT:"Pittsburgh", STL:"St. Louis", WSH:"Washington", UTA:"Utah", VAN:"Vancouver", SEA:"Seattle", CBJ:"Columbus", WPG:"Winnipeg", CGY:"Calgary", PHI:"Philadelphia" };
const TEAM_FULL_NAMES = {
  "Anaheim Ducks":"ANA","Boston Bruins":"BOS","Buffalo Sabres":"BUF","Calgary Flames":"CGY",
  "Carolina Hurricanes":"CAR","Chicago Blackhawks":"CHI","Colorado Avalanche":"COL",
  "Columbus Blue Jackets":"CBJ","Dallas Stars":"DAL","Detroit Red Wings":"DET","Edmonton Oilers":"EDM",
  "Florida Panthers":"FLA","Los Angeles Kings":"LAK","Minnesota Wild":"MIN","Montreal Canadiens":"MTL",
  "Nashville Predators":"NSH","New Jersey Devils":"NJD","New York Islanders":"NYI","New York Rangers":"NYR",
  "Ottawa Senators":"OTT","Philadelphia Flyers":"PHI","Pittsburgh Penguins":"PIT","San Jose Sharks":"SJS",
  "Seattle Kraken":"SEA","St. Louis Blues":"STL","Tampa Bay Lightning":"TBL","Toronto Maple Leafs":"TOR",
  "Utah Hockey Club":"UTA","Utah Mammoth":"UTA","Vancouver Canucks":"VAN","Vegas Golden Knights":"VGK",
  "Washington Capitals":"WSH","Winnipeg Jets":"WPG"
};
const stripAccents=v=>String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toLowerCase();
const TEAM_FULL_NAME_KEYS = new Map(Object.entries(TEAM_FULL_NAMES).map(([name,abbr])=>[stripAccents(name),abbr]));
function teamCodeFromRow(r) {
  const val=v=>v&&typeof v==="object"?(v.default??v.abbrev??v.code??""):v;
  const direct=val(r?.teamAbbrev??r?.teamAbbreviation??r?.teamCode);
  if(direct && /^[A-Za-z]{2,4}$/.test(String(direct).trim())) return canonicalTeam(direct);
  // NHL skater/goalie summary rows use plural `teamAbbrevs` (e.g. "EDM" or "TOR,EDM" after a mid-season trade); use the most recent team.
  const multi=val(r?.teamAbbrevs);
  if(multi){const last=String(multi).split(/[,\/\s]+/).filter(Boolean).pop();if(last&&/^[A-Za-z]{2,4}$/.test(last))return canonicalTeam(last);}
  const teamValue=val(r?.team);
  if(teamValue && /^[A-Za-z]{2,4}$/.test(String(teamValue).trim())) return canonicalTeam(teamValue);
  const full=stripAccents(val(r?.teamFullName??r?.teamName??r?.franchiseName??teamValue)??"");
  return TEAM_FULL_NAME_KEYS.get(full)||canonicalTeam(full);
}
const PLAYER_ALIASES = { "Hughes, Jack|NJ":"Hughes, Jack|NJD", "Evangelista, Luke|NJ":"Evangelista, Luke|NJD", "Mantha, Anthony|NJ":"Mantha, Anthony|NJD" };

const db = new Database(path.join(__dirname, "pool.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at ON snapshots(captured_at);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_name TEXT NOT NULL,
  slot INTEGER NOT NULL,
  old_name TEXT NOT NULL,
  old_team TEXT NOT NULL,
  new_name TEXT NOT NULL,
  new_team TEXT NOT NULL,
  position TEXT NOT NULL,
  traded_at TEXT NOT NULL,
  old_points INTEGER NOT NULL DEFAULT 0,
  old_stats_json TEXT NOT NULL DEFAULT '{}',
  new_stats_json TEXT NOT NULL DEFAULT '{}',
  undone_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_trade_per_entry ON trades(pool_name) WHERE undone_at IS NULL;
CREATE TABLE IF NOT EXISTS participants_meta (pool_name TEXT PRIMARY KEY, paid INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS name_mappings (pool_name TEXT NOT NULL, source_name TEXT NOT NULL, source_team TEXT NOT NULL, nhl_name TEXT NOT NULL, nhl_team TEXT NOT NULL DEFAULT '', PRIMARY KEY(pool_name,source_name,source_team));
`);
for (const p of participants) db.prepare("INSERT OR IGNORE INTO participants_meta(pool_name,paid) VALUES (?,0)").run(p.poolName);
db.exec("CREATE TABLE IF NOT EXISTS seed_imports (key TEXT PRIMARY KEY, imported_at TEXT NOT NULL)");
if (!db.prepare("SELECT key FROM seed_imports WHERE key='spreadsheet-trades-v1'").get()) {
 try {
  const seedTrades=JSON.parse(fs.readFileSync(path.join(__dirname,"data/seed-trades.json"),"utf8"));
  const insert=db.prepare("INSERT INTO trades(pool_name,slot,old_name,old_team,new_name,new_team,position,traded_at,old_points,old_stats_json,new_stats_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const run=db.transaction(()=>{
   for(const t of seedTrades){
    const existing=db.prepare("SELECT id FROM trades WHERE pool_name=? AND undone_at IS NULL").get(t.poolName);
    if(!existing) insert.run(t.poolName,t.slot,t.old_name,t.old_team,t.new_name,t.new_team,t.position,t.traded_at,t.old_points,JSON.stringify(t.old_stats),JSON.stringify(t.new_stats));
   }
   db.prepare("INSERT INTO seed_imports(key,imported_at) VALUES ('spreadsheet-trades-v1',?)").run(new Date().toISOString());
  });
  run();
  console.log(`Imported spreadsheet trade history (${seedTrades.length} records considered)`);
 } catch(e) { console.error("Spreadsheet trade import unavailable:",e.message); }
}

function normName(v) { let s=String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[.'’]/g,"").replace(/\s+/g," "); if(s.includes(",")){const [last,first]=s.split(",").map(x=>x.trim());s=`${first} ${last}`.trim();} return s; }
function canonicalTeam(t){return TEAM_ALIASES[String(t||"").toUpperCase()]||String(t||"").toUpperCase();}
function canonicalPlayerKey(name,team){const raw=`${name}|${team}`;return PLAYER_ALIASES[raw]||`${name}|${canonicalTeam(team)}`;}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0;}
function positionLabel(pos){return pos==="F"?"Forward":pos==="D"?"Defence":pos==="G"?"Goalie":"Team";}
function iso(d){return new Date(d).toISOString();}

async function fetchJSON(url){
 const r=await fetch(url,{headers:{"User-Agent":"BMO2026-NHL-Pool-Tracker/2.1","Accept":"application/json"}});
 if(!r.ok)throw new Error(`NHL API ${r.status} for ${url}`);
 return r.json();
}
function cayenne(seasonId,gameTypeId){return encodeURIComponent(`seasonId=${seasonId} and gameTypeId=${gameTypeId}`);}
async function fetchSummary(kind){
 const url=`${API_BASE}/${kind}/summary?isAggregate=false&isGame=false&start=0&limit=-1&cayenneExp=${cayenne(config.seasonId,config.gameTypeId)}`;
 const data=await fetchJSON(url);
 if(!data||!Array.isArray(data.data)) throw new Error(`Unexpected NHL ${kind} summary response`);
 return data.data;
}
async function fetchTeamStats(){
 try{
  const rows=await fetchSummary("team");
  if(rows.length&&rows.some(r=>teamCodeFromRow(r)))return rows;
  console.warn("NHL team summary returned zero usable team rows; trying official current standings endpoint");
 }catch(e){console.warn("NHL team summary unavailable; trying official current standings endpoint:",e.message);}
 const data=await fetchJSON("https://api-web.nhle.com/v1/standings/now");
 const standings=Array.isArray(data.standings)?data.standings:[];
 return standings.map(r=>({
  teamAbbrev:r.teamAbbrev?.default||r.teamAbbrev||r.teamAbbreviation||"",
  teamFullName:r.teamName?.default||r.teamFullName||"",
  gamesPlayed:r.gamesPlayed??r.gp??0,
  wins:r.wins??r.w??0,
  losses:r.losses??r.l??0,
  otLosses:r.otLosses??r.otLoss??r.otl??0,
  goalsFor:r.goalFor??r.goalsFor??0,
  goalsAgainst:r.goalAgainst??r.goalsAgainst??0
 }));
}
async function fetchAllStats(){
 const [skaters,goalies,teams]=await Promise.all([fetchSummary("skater"),fetchSummary("goalie"),fetchTeamStats()]);
 return {skaters,goalies,teams};
}
function indexStats(stats){
 const sk=new Map(),go=new Map(),te=new Map();
 for(const r of stats.skaters){
  const name=r.skaterFullName||r.playerFullName||r.fullName||r.name||"";
  const team=teamCodeFromRow(r);
  if(name&&team)sk.set(`${normName(name)}|${team}`,r);
 }
 for(const r of stats.goalies){
  const name=r.goalieFullName||r.playerFullName||r.fullName||r.name||"";
  const team=teamCodeFromRow(r);
  if(name&&team)go.set(`${normName(name)}|${team}`,r);
 }
 for(const r of stats.teams){const team=teamCodeFromRow(r);if(team)te.set(team,r);}
 return {sk,go,te};
}
function statValue(row,cat){const aliases={GP:["gamesPlayed","gp"],G:["goals","g"],A:["assists","a"],PTS:["points","pts"],plusMinus:["plusMinus","plusMinusRating"],PIM:["penaltyMinutes","pim"],PPG:["powerPlayGoals","ppGoals"],PPA:["powerPlayAssists","ppAssists"],PPP:["powerPlayPoints","ppPoints"],SHG:["shorthandedGoals","shGoals"],SHA:["shorthandedAssists","shAssists"],SHP:["shPoints","shorthandedPoints"],W:["wins","w"],L:["losses","l"],OTL:["otLosses","otl"],SO:["shutouts","so"],SV:["saves","sv"],GA:["goalsAgainst","ga"],GAA:["goalsAgainstAverage","gaa"],SVPct:["savePct","savePercentage"],GF:["goalsFor","gf"]};for(const k of aliases[cat]||[cat])if(row&&row[k]!==undefined&&row[k]!==null)return num(row[k]);return 0;}
function pointsFor(row,position){const rules=config.scoring[position]||{};return Object.entries(rules).reduce((sum,[cat,mult])=>sum+statValue(row,cat)*num(mult),0);}
let cachedSeedSnapshot=null;
function seedFallbackRow(sel,poolName){
 try{
  if(!cachedSeedSnapshot)cachedSeedSnapshot=JSON.parse(fs.readFileSync(path.join(__dirname,"data/seed-snapshot.json"),"utf8"));
  const seed=cachedSeedSnapshot;
  const owner=(seed.standings||[]).find(s=>s.poolName===poolName);
  const p=(owner?.players||[]).find(x=>Number(x.round)===Number(sel.round)&&x.name===sel.name);
  if(!p)return null;
  const s=p.stats||{};
  const common={teamAbbrev:canonicalTeam(p.team),gamesPlayed:num(s.GP)};
  if(p.position==="T")return {...common,wins:num(s.W),losses:num(s.L),otLosses:num(s.OTL),goalsFor:num(s.GF),goalsAgainst:num(s.GA),__seedFallback:true};
  if(p.position==="G")return {...common,goalieFullName:p.name,wins:num(s.W),losses:num(s.L),otLosses:num(s.OTL),shutouts:num(s.SO),saves:num(s.SV),goalsAgainst:num(s.GA),goalsAgainstAverage:num(s.GAA),savePct:num(s.SVPct),__seedFallback:true};
  return {...common,skaterFullName:p.name,goals:num(s.G),assists:num(s.A),points:num(s.PTS),plusMinus:num(s.plusMinus),penaltyMinutes:num(s.PIM),powerPlayGoals:num(s.PPG),powerPlayAssists:num(s.PPA),powerPlayPoints:num(s.PPP),shorthandedGoals:num(s.SHG),shorthandedAssists:num(s.SHA),shorthandedPoints:num(s.SHP),__seedFallback:true};
 }catch{return null;}
}
function findRow(ix,sel,poolName=""){
 if(sel.position==="T"){
  const row=ix.te.get(canonicalTeam(sel.team))||null;
  return row||seedFallbackRow(sel,poolName);
 }
 const map=sel.position==="G"?ix.go:ix.sk;
 const mapped=db.prepare("SELECT nhl_name,nhl_team FROM name_mappings WHERE pool_name=? AND source_name=? AND source_team=?").get(poolName,sel.name,sel.team);
 const lookupName=mapped?.nhl_name||sel.name, lookupTeam=mapped?.nhl_team||sel.team;
 const exact=map.get(`${normName(lookupName)}|${canonicalTeam(lookupTeam)}`);
 if(exact)return exact;
 const sameName=[...map.entries()].filter(([key])=>key.split("|")[0]===normName(lookupName));
 if(sameName.length===1)return sameName[0][1];
 return seedFallbackRow(sel,poolName);
}
function statsOut(row,matchType){const o={};for(const cat of (config.categories[matchType]||[]))o[cat]=statValue(row||{},cat);return o;}
function tradeRows(activeOnly=true){return db.prepare(`SELECT * FROM trades ${activeOnly?"WHERE undone_at IS NULL":""} ORDER BY traded_at ASC`).all();}
function tradeFor(pool,slot){return db.prepare("SELECT * FROM trades WHERE pool_name=? AND slot=? AND undone_at IS NULL").get(pool,slot);}
function allTradesForPool(pool){return db.prepare("SELECT * FROM trades WHERE pool_name=? ORDER BY traded_at ASC").all(pool);}
function originalRoster(pool){return rosters[pool]||[];}
function currentSelection(pool,slot){const orig=originalRoster(pool).find(x=>x.round===slot);const t=tradeFor(pool,slot);return t?{round:slot,name:t.new_name,team:t.new_team,position:t.position,traded:true,originalName:t.old_name,originalTeam:t.old_team,tradeId:t.id,tradedAt:t.traded_at}:orig?{...orig,traded:false}:null;}
function rosterWithHistory(pool){return Array.from({length:27},(_,slot)=>currentSelection(pool,slot)).filter(Boolean);}

function buildState(stats, capturedAt=new Date().toISOString()){
 const ix=indexStats(stats), standings=[], ownerIndex=new Map(), franchiseCount=new Map(), rosterTeamCount=new Map();
 for(const p of participants){
  const players=[];let total=0,goals=0,assists=0;
  for(let slot=0;slot<27;slot++){
   const sel=currentSelection(p.poolName,slot);if(!sel)continue;
   const matchType=sel.position==="G"?"goalie":sel.position==="T"?"team":"skater";
   const currentRow=findRow(ix,sel,p.poolName);const currentStats=statsOut(currentRow,matchType);
   let points=pointsFor(currentRow||{},sel.position);let effectiveStats=currentStats;let frozen=false;
   const t=tradeFor(p.poolName,slot);
   if(t){
     const tradedAt=new Date(t.traded_at).getTime(), snapshotAt=new Date(capturedAt).getTime();
     if(snapshotAt>=tradedAt){
       const oldStats=JSON.parse(t.old_stats_json||"{}");
       const newBase=JSON.parse(t.new_stats_json||"{}");
       points=Number(t.old_points||0)+Math.max(0,points-pointsFor(newBase,sel.position));
       effectiveStats={};for(const cat of Object.keys(currentStats))effectiveStats[cat]=Number(oldStats[cat]||0)+Math.max(0,currentStats[cat]-Number(newBase[cat]||0));
       frozen=true;
     }
   }
   total+=points;goals+=effectiveStats.G||0;assists+=effectiveStats.A||0;
   const player={round:slot,name:sel.name,team:sel.team,position:sel.position,points,stats:effectiveStats,found:!!currentRow,statsAvailable:!!currentRow&&!currentRow.__seedFallback,traded:!!sel.traded,originalName:sel.originalName,originalTeam:sel.originalTeam,tradedAt:sel.tradedAt,frozen};
   players.push(player);
   const ownerKey=canonicalPlayerKey(sel.name,sel.team);if(!ownerIndex.has(ownerKey))ownerIndex.set(ownerKey,[]);ownerIndex.get(ownerKey).push({owner:p.name,poolName:p.poolName,points,position:sel.position,traded:!!sel.traded});
   const franchise=canonicalTeam(sel.team);
   if(sel.position==="T") franchiseCount.set(franchise,(franchiseCount.get(franchise)||0)+1);
   else rosterTeamCount.set(franchise,(rosterTeamCount.get(franchise)||0)+1);
  }
  standings.push({poolName:p.poolName,name:p.name,fullName:p.fullName,points:total,goals,assists,players,paid:!!db.prepare("SELECT paid FROM participants_meta WHERE pool_name=?").get(p.poolName)?.paid});
 }
 standings.sort((a,b)=>b.points-a.points||b.goals-a.goals||b.assists-a.assists||a.name.localeCompare(b.name));
 let last=null,rank=0;standings.forEach((x,i)=>{if(last!==x.points)rank=i+1;x.rank=rank;last=x.points;});
 const prev=db.prepare("SELECT data_json FROM snapshots ORDER BY id DESC LIMIT 1").get();if(prev){try{const old=JSON.parse(prev.data_json);const m=new Map(old.standings.map(x=>[x.poolName,x.rank]));for(const x of standings)x.movement=m.has(x.poolName)?m.get(x.poolName)-x.rank:0;}catch{for(const x of standings)x.movement=0;}}else for(const x of standings)x.movement=0;
 const draftedCounts=new Map();let rosterSpots=0;for(const s of standings){for(const p of s.players){rosterSpots++;const key=`${p.name}|${p.team}|${p.position}`;draftedCounts.set(key,(draftedCounts.get(key)||0)+1);}}
 const skaters=[...draftedCounts.entries()].filter(([k])=>k.endsWith("|F")||k.endsWith("|D")).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 const goalies=[...draftedCounts.entries()].filter(([k])=>k.endsWith("|G")).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 const franchise=[...franchiseCount.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 const rosterTeams=[...rosterTeamCount.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 const statsQuality={unmatched:[],noCurrentStats:[],lastSyncAt:capturedAt};for(const s of standings)for(const p of s.players){
  if(!p.found)statsQuality.unmatched.push({owner:s.name,round:p.round,name:p.name,team:p.team,position:p.position});
  else if(p.statsAvailable===false)statsQuality.noCurrentStats.push({owner:s.name,round:p.round,name:p.name,team:p.team,position:p.position});
 }
 return {updatedAt:capturedAt,seasonId:config.seasonId,gameTypeId:config.gameTypeId,scoring:config.scoring,standings,playerIndex:Object.fromEntries([...ownerIndex.entries()]),poolNumbers:{mostDraftedSkater:skaters[0]?{name:skaters[0][0].split("|")[0],team:skaters[0][0].split("|")[1],count:skaters[0][1]}:null,mostDraftedGoalie:goalies[0]?{name:goalies[0][0].split("|")[0],team:goalies[0][0].split("|")[1],count:goalies[0][1]}:null,mostDraftedFranchise:franchise[0]?{team:franchise[0][0],name:TEAM_NAMES[franchise[0][0]]||franchise[0][0],count:franchise[0][1]}:null,mostRosteredNHLTeam:rosterTeams[0]?{team:rosterTeams[0][0],name:TEAM_NAMES[rosterTeams[0][0]]||rosterTeams[0][0],count:rosterTeams[0][1]}:null,uniquePlayers:draftedCounts.size,rosterSpots},statsQuality};
}

async function fetchAndBuild(){
 const stats=await fetchAllStats();
 console.log(`NHL regular-season API rows: skaters=${stats.skaters.length}, goalies=${stats.goalies.length}, teams=${stats.teams.length}`);
 if(stats.skaters.length===0&&stats.goalies.length===0) throw new Error("NHL API returned no skater or goalie stats; refusing to replace the last good standings snapshot");
 const ix=indexStats(stats);
 const teamPicks=participants.flatMap(p=>originalRoster(p.poolName)).filter(p=>p.position==="T");
 const teamMatched=teamPicks.filter(p=>ix.te.has(canonicalTeam(p.team))).length;
 console.log(`NHL franchise picks: matched=${teamMatched}/${teamPicks.length}; team codes returned=${[...ix.te.keys()].join(",")||"(none)"}`);
 const state=buildState(stats);
 const all=state.standings.flatMap(s=>s.players||[]);
 console.log(`Pool sync result: participants=${state.standings.length}, rosterSpots=${all.length}, matched=${all.filter(p=>p.found).length}, liveStats=${all.filter(p=>p.statsAvailable).length}, spreadsheetFallback=${all.filter(p=>p.statsAvailable===false&&p.found).length}, unmatched=${all.filter(p=>!p.found).length}`);
 return {stats,state};
}
async function refresh(reason="manual"){const start=new Date(`${config.seasonStart}T00:00:00-04:00`);const end=new Date(`${config.seasonEnd}T23:59:59-04:00`);if(Date.now()<start.getTime())return {...latest(),seasonStatus:"not_started",updatedAt:null};if(Date.now()>end.getTime())return {...latest(),seasonStatus:"ended"};const {state}=await fetchAndBuild();state.seasonStatus="active";db.prepare("INSERT INTO snapshots(captured_at,data_json) VALUES (?,?)").run(state.updatedAt,JSON.stringify(state));return state;}
function latest(){const row=db.prepare("SELECT data_json FROM snapshots ORDER BY id DESC LIMIT 1").get();return row?JSON.parse(row.data_json):{updatedAt:null,standings:[],poolNumbers:null,statsQuality:{unmatched:[]}};}
function installSeedSnapshotIfNeeded(){
 try{
  const seed=JSON.parse(fs.readFileSync(path.join(__dirname,"data/seed-snapshot.json"),"utf8"));
  const current=latest();
  const currentRosterCount=(current.standings||[]).reduce((n,s)=>n+(s.players||[]).length,0);
  const seedRosterCount=(seed.standings||[]).reduce((n,s)=>n+(s.players||[]).length,0);
  const currentNames=new Set((current.standings||[]).map(s=>s.poolName));
  const seedNames=new Set((seed.standings||[]).map(s=>s.poolName));
  let rosterMismatch=currentRosterCount!==seedRosterCount||currentNames.size!==seedNames.size||[...seedNames].some(n=>!currentNames.has(n));
  if(!rosterMismatch){
   for(const seedEntry of seed.standings||[]){
    const liveEntry=(current.standings||[]).find(s=>s.poolName===seedEntry.poolName);
    if(!liveEntry){rosterMismatch=true;break;}
    const livePlayers=new Map((liveEntry.players||[]).map(p=>[Number(p.round),p]));
    for(const seedPlayer of seedEntry.players||[]){
     const livePlayer=livePlayers.get(Number(seedPlayer.round));
     if(!livePlayer||livePlayer.name!==seedPlayer.name||livePlayer.position!==seedPlayer.position){
      rosterMismatch=true;break;
     }
    }
    if(rosterMismatch)break;
   }
  }
  const currentTime=current.updatedAt?new Date(current.updatedAt).getTime():0;
  const seedTime=seed.updatedAt?new Date(seed.updatedAt).getTime():0;
  const needsSeed=!currentRosterCount||rosterMismatch||currentTime<seedTime;
  if(needsSeed){
   let seedTrades=[];
   try{seedTrades=JSON.parse(fs.readFileSync(path.join(__dirname,"data/seed-trades.json"),"utf8"));}catch{}
   const activeTrades=db.prepare("SELECT pool_name,slot,new_name FROM trades WHERE undone_at IS NULL").all();
   const activeTradesMatchSeed=activeTrades.every(t=>seedTrades.some(s=>s.poolName===t.pool_name&&Number(s.slot)===Number(t.slot)&&s.new_name===t.new_name));
   if(activeTrades.length&&!activeTradesMatchSeed){
    console.warn("Stored snapshot differs from spreadsheet seed, but non-seed active trades exist; preserving trade history and attempting live NHL refresh");
   }else{
    db.prepare("INSERT INTO snapshots(captured_at,data_json) VALUES (?,?)").run(seed.updatedAt||new Date().toISOString(),JSON.stringify(seed));
    console.log("Installed latest spreadsheet standings as fallback snapshot");
   }
  }
 }catch(e){console.error("Seed snapshot unavailable:",e.message);}
}
function ageMinutes(){const x=latest().updatedAt;return x?((Date.now()-new Date(x).getTime())/60000):Infinity;}
function validSlotOption(slot,name,team){return (slotOptions[String(slot)]||[]).some(x=>normName(x.name)===normName(name)&&canonicalTeam(x.team)===canonicalTeam(team));}

app.get("/api/config",(req,res)=>res.json({leagueName:config.leagueName,seasonId:config.seasonId,gameTypeId:config.gameTypeId,updateSchedule:config.updateSchedule,timezone:config.timezone,scoring:config.scoring,regularSeasonOnly:true,tradeWindow:"one active trade per entry",seasonStart:config.seasonStart,seasonEnd:config.seasonEnd}));
app.get("/api/standings",(req,res)=>res.json(latest()));
app.get("/api/history",(req,res)=>res.json(db.prepare("SELECT captured_at,data_json FROM snapshots ORDER BY captured_at ASC").all().map(r=>{const d=JSON.parse(r.data_json);return {capturedAt:r.captured_at,standings:d.standings.map(x=>({poolName:x.poolName,name:x.name,points:x.points,rank:x.rank}))};})));
app.get("/api/participants",(req,res)=>res.json(participants.map(p=>({...p,paid:!!db.prepare("SELECT paid FROM participants_meta WHERE pool_name=?").get(p.poolName)?.paid}))));
app.get("/api/slots",(req,res)=>res.json(slotOptions));
app.get("/api/trades",(req,res)=>res.json(tradeRows(false)));
app.post("/api/refresh",async(req,res)=>{const token=process.env.REFRESH_TOKEN;if(token&&req.get("X-Refresh-Token")!==token)return res.status(401).json({error:"Unauthorized"});try{res.json(await refresh("manual"));}catch(e){console.error(e);res.status(502).json({error:e.message});}});

app.post("/api/trades",async(req,res)=>{
 try{
  const seasonStart=new Date(`${config.seasonStart}T00:00:00-04:00`); if(Date.now()<seasonStart.getTime()) return res.status(409).json({error:"Trades are unavailable until the regular season opens."});
  if(ageMinutes()>10) return res.status(409).json({error:"Trades are locked until NHL stats are under 10 minutes old. Refresh NHL stats first."});
  const {poolName,slot,newName,newTeam}=req.body||{};const participant=participants.find(p=>p.poolName===poolName);const slotNum=Number(slot);
  if(!participant||!Number.isInteger(slotNum)||slotNum<0||slotNum>26) return res.status(400).json({error:"Invalid participant or slot."});
  if(tradeFor(poolName,slotNum)) return res.status(409).json({error:"This entry has already used its trade."});
  const orig=originalRoster(poolName).find(x=>x.round===slotNum);if(!orig)return res.status(400).json({error:"Original pick not found."});
  const option=(slotOptions[String(slotNum)]||[]).find(x=>normName(x.name)===normName(newName)&&canonicalTeam(x.team)===canonicalTeam(newTeam));if(!option)return res.status(400).json({error:"New pick must be an option from the exact same pool-sheet slot."});
  const {state,stats}=await fetchAndBuild();const owner=state.standings.find(x=>x.poolName===poolName);const oldPlayer=owner?.players.find(x=>x.round===slotNum);const ixStats=oldPlayer?oldPlayer.stats:{};
  const oldPoints=oldPlayer?.points||0;
  const newType=option.position==="G"?"goalie":option.position==="T"?"team":"skater";
  const ix=indexStats(stats);const newRow=findRow(ix,option,poolName);const newStats=statsOut(newRow,newType);
  const now=iso(new Date());db.prepare("INSERT INTO trades(pool_name,slot,old_name,old_team,new_name,new_team,position,traded_at,old_points,old_stats_json,new_stats_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(poolName,slotNum,orig.name,orig.team,option.name,option.team,option.position,now,oldPoints,JSON.stringify(ixStats),JSON.stringify(newStats));
  await refresh("trade");res.json({ok:true,trade:tradeFor(poolName,slotNum),state:latest()});
 }catch(e){console.error(e);res.status(500).json({error:e.message});}
});

app.post("/api/admin/login",(req,res)=>{res.json({ok:req.body?.passphrase===ADMIN_PASSPHRASE});});
function adminGate(req,res,next){if(req.get("X-Admin-Passphrase")!==ADMIN_PASSPHRASE)return res.status(401).json({error:"Invalid admin passphrase"});next();}
app.post("/api/admin/name-map",adminGate,(req,res)=>{const {poolName,name,team,nhlName,nhlTeam}=req.body||{};if(!poolName||!name||!team||!nhlName)return res.status(400).json({error:"Pool name, source name/team and NHL spelling are required"});db.prepare("INSERT INTO name_mappings(pool_name,source_name,source_team,nhl_name,nhl_team) VALUES (?,?,?,?,?) ON CONFLICT(pool_name,source_name,source_team) DO UPDATE SET nhl_name=excluded.nhl_name,nhl_team=excluded.nhl_team").run(poolName,name,team,nhlName,nhlTeam||team);res.json({ok:true});});
app.post("/api/admin/paid",adminGate,(req,res)=>{const {poolName,paid}=req.body||{};if(!participants.some(p=>p.poolName===poolName))return res.status(400).json({error:"Unknown participant"});db.prepare("UPDATE participants_meta SET paid=? WHERE pool_name=?").run(paid?1:0,poolName);res.json({ok:true});});
app.post("/api/admin/undo-trade",adminGate,async(req,res)=>{const id=Number(req.body?.tradeId);const t=db.prepare("SELECT * FROM trades WHERE id=? AND undone_at IS NULL").get(id);if(!t)return res.status(404).json({error:"Active trade not found"});db.prepare("UPDATE trades SET undone_at=? WHERE id=?").run(iso(new Date()),id);try{await refresh("undo-trade");}catch(e){console.error(e);}res.json({ok:true,state:latest()});});
app.get("/api/admin/status",adminGate,(req,res)=>{
 const state=latest();
 const franchisePicks=(state.standings||[]).flatMap(s=>(s.players||[]).filter(p=>p.position==="T").map(p=>({owner:s.name,name:p.name,team:p.team,points:p.points,stats:p.stats})));
 res.json({updatedAt:state.updatedAt,ageMinutes:ageMinutes(),unmatched:state.statsQuality?.unmatched||[],noCurrentStats:state.statsQuality?.noCurrentStats||[],franchisePicks,trades:tradeRows(false),participants:participants.map(p=>({...p,paid:!!db.prepare("SELECT paid FROM participants_meta WHERE pool_name=?").get(p.poolName)?.paid}))});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public/index.html")));
cron.schedule(config.updateSchedule,async()=>{try{await refresh("scheduled");console.log("Scheduled NHL refresh complete");}catch(e){console.error("Scheduled NHL refresh failed:",e.message);}}, {timezone:config.timezone});
app.listen(PORT,async()=>{
 console.log(`BMO2026 tracker listening on ${PORT}`);
 installSeedSnapshotIfNeeded();
 try{await refresh("startup");console.log("Startup NHL refresh complete");}
 catch(e){console.error("Startup NHL refresh failed; keeping last good snapshot:",e.message);}
});
