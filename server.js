// ==========================================
// RE国際銀行 バックエンド v5
// 日割り金利・預金金利元金ベース単利・%入力対応
// ==========================================
const express      = require('express');
const cors         = require('cors');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const { Pool }     = require('pg');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, Colors,
} = require('discord.js');

const app  = express();
const PORT = process.env.PORT || 3000;

const C = {
  BOT_TOKEN:   process.env.DISCORD_BOT_TOKEN   || '',
  CLIENT_ID:   process.env.DISCORD_CLIENT_ID   || '',
  GUILD_ID:    '1484801069346459720',
  CH_ANNOUNCE: process.env.DISCORD_ANNOUNCE_CH || '',
  SITE_URL:    process.env.SITE_URL            || 'https://rarala.online',
  COOKIE_SEC:  process.env.COOKIE_SECRET       || 'change-this',
  ADMIN_KEY:   process.env.ADMIN_KEY           || 'change-admin',
  TOKEN_EXP:   15,
  SESSION_DAYS:30,
};

// ── DB接続 ──────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
async function q(text, params = []) {
  const c = await pool.connect();
  try { return await c.query(text, params); }
  finally { c.release(); }
}

// ── 設定キャッシュ ────────────────────────
let settingsCache = {};
async function loadSettings() {
  const r = await q('SELECT key, value FROM settings');
  r.rows.forEach(row => { settingsCache[row.key] = row.value; });
  return settingsCache;
}
function getSetting(key, defaultVal) {
  return settingsCache[key] !== undefined ? Number(settingsCache[key]) : defaultVal;
}

// ── ミドルウェア ──────────────────────────
app.use(cors({ origin: [C.SITE_URL, 'http://localhost'], credentials: true }));
app.use(express.json());
app.use(cookieParser(C.COOKIE_SEC));

// ==========================================
// 金利計算（承認日時から日割り計算）
// 「○日で○%」→ 1日あたり (率÷日数) で毎日増える
// ==========================================
function calcInterest(loan) {
  if (!loan.approved_at) {
    return {
      principal: loan.principal, interest: 0, total: loan.principal,
      remain: Math.max(0, loan.principal - (loan.paid_amount||0)),
      elapsedDays: 0, dailyRate: 0, deadlineDate: '未承認', overdue: false,
    };
  }
  const isNat       = loan.loan_type === 'national';
  const rate        = getSetting(isNat ? 'national_rate' : 'personal_rate', 0.20);
  const cycleDays   = getSetting(isNat ? 'national_cycle_days' : 'personal_cycle_days', isNat ? 30 : 10);
  const deadDays    = getSetting(isNat ? 'national_deadline_days' : 'personal_deadline_days', isNat ? 365 : 180);

  const now         = Date.now();
  const start       = new Date(loan.approved_at).getTime();
  const elapsedDays = (now - start) / 86400000;

  // 日割り：例「10日で20%」→ 1日で2% → dailyRate=0.02
  const dailyRate = rate / cycleDays;
  const interest  = Math.floor(loan.principal * dailyRate * elapsedDays);
  const total     = loan.principal + interest;
  const remain    = Math.max(0, total - (loan.paid_amount || 0));

  const extDays      = loan.deadline_extended || 0;
  const deadlineMs   = start + (deadDays + extDays) * 86400000;
  const deadlineDate = new Date(deadlineMs).toLocaleDateString('ja-JP');
  const overdue      = now > deadlineMs && !['completed','rejected'].includes(loan.status);

  return {
    principal: loan.principal, interest, total, remain,
    elapsedDays: Math.floor(elapsedDays), dailyRate, rate, cycleDays,
    deadlineDate, overdue,
  };
}

// ==========================================
// 預金金利を適用（年1回・元金ベース単利）
// 元金 = 残高 - 今までに追加した利息の累計
// ==========================================
async function applyDepositInterest(discordId) {
  try {
    const ar = await q(`SELECT * FROM accounts WHERE discord_id=$1`, [discordId]);
    if (!ar.rows[0]) return;
    const account = ar.rows[0];

    const lastInterestAt = new Date(account.last_interest_at).getTime();
    const now            = Date.now();
    const oneYear        = 365 * 24 * 60 * 60 * 1000;

    // 前回の金利適用から1年経っていない場合はスキップ
    if (now - lastInterestAt < oneYear) return;

    const rate         = getSetting('deposit_rate', 0.0002);
    const balance      = Number(account.balance);
    const interestPaid = Number(account.interest_paid || 0);

    // 元金部分 = 残高 - 今まで増やした利息の累計
    const principal = Math.max(0, balance - interestPaid);
    const addAmount = Math.floor(principal * rate);
    if (addAmount <= 0) return;

    await q(
      `UPDATE accounts SET balance=balance+$1, interest_paid=COALESCE(interest_paid,0)+$1, last_interest_at=NOW() WHERE discord_id=$2`,
      [addAmount, discordId]
    );

    const txId = genId('TX');
    await q(
      `INSERT INTO transactions (id,from_discord_id,to_discord_id,amount,type,note) VALUES ($1,NULL,$2,$3,'interest','年次預金金利')`,
      [txId, discordId, addAmount]
    );

    await pushNotice(discordId, {
      title: '💰 預金金利が付きました',
      body:  `元金 ${principal.toLocaleString()} RSD × ${(rate*100).toFixed(3)}% = ${addAmount.toLocaleString()} RSD が口座に追加されました。`,
      color: 'green',
    });

    console.log(`預金金利適用: ${discordId} +${addAmount} RSD`);
  } catch (e) {
    console.error('預金金利エラー:', e.message);
  }
}

// ── ヘルパー ──────────────────────────────
function genId(prefix) {
  const d = new Date();
  const p = n => String(n).padStart(2,'0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${Math.floor(Math.random()*9000+1000)}`;
}
async function genToken(discordId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO login_tokens (token,discord_id,expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [token, discordId, new Date(Date.now() + C.TOKEN_EXP*60000)]);
  return token;
}
async function createSession(res, discordId) {
  const sid = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO sessions (session_id,discord_id,expires_at) VALUES ($1,$2,$3)`,
    [sid, discordId, new Date(Date.now() + C.SESSION_DAYS*86400000)]);
  res.cookie('re_session', sid, {
    httpOnly:true, secure: process.env.NODE_ENV==='production',
    sameSite:'lax', maxAge: C.SESSION_DAYS*86400000, signed:true,
  });
}
async function getUser(req) {
  const sid = req.signedCookies?.re_session;
  if (!sid) return null;
  const r = await q(
    `SELECT u.* FROM sessions s JOIN users u ON s.discord_id=u.discord_id WHERE s.session_id=$1 AND s.expires_at>NOW()`,
    [sid]);
  return r.rows[0] || null;
}
async function pushNotice(discordId, { title, body, color='blue', loanId=null }) {
  await q(`INSERT INTO notices (id,discord_id,title,body,color,loan_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [crypto.randomBytes(8).toString('hex'), discordId, title, body, color, loanId]);
}

// ==========================================
// Discord BOT
// ==========================================
const bot = new Client({
  intents:[GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages],
});

async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder().setName('login').setDescription('ダッシュボードのログインURLをDMで受け取る').toJSON(),
    new SlashCommandBuilder().setName('balance').setDescription('残高・口座・返済状況を確認する').toJSON(),
    new SlashCommandBuilder()
      .setName('announce').setDescription('【運営専用】全体お知らせを投稿する')
      .addStringOption(o=>o.setName('title').setDescription('タイトル').setRequired(true))
      .addStringOption(o=>o.setName('message').setDescription('本文').setRequired(true))
      .addStringOption(o=>o.setName('color').setDescription('色').setRequired(false)
        .addChoices({name:'青',value:'blue'},{name:'緑',value:'green'},{name:'赤',value:'red'},{name:'金',value:'gold'}))
      .toJSON(),
  ];
  const rest = new REST({version:'10'}).setToken(C.BOT_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(C.CLIENT_ID,C.GUILD_ID),{body:cmds});
    console.log('✅ コマンド登録完了');
  } catch(e){console.error('❌',e.message);}
}

bot.once('ready', async()=>{ console.log(`✅ BOT起動: ${bot.user.tag}`); await registerCommands(); await loadSettings(); });

async function postGlobalAnnounce(embed) {
  if(!C.CH_ANNOUNCE) return;
  try { const ch=await bot.channels.fetch(C.CH_ANNOUNCE); await ch?.send({embeds:[embed]}); } catch{}
}
async function sendDM(discordId, embed) {
  try { const u=await bot.users.fetch(discordId); await u.send({embeds:[embed]}); return true; } catch{return false;}
}
async function sendLoginDM(discordId) {
  const r = await q(`SELECT * FROM users WHERE discord_id=$1`,[discordId]);
  if(!r.rows[0]) return {ok:false,error:'アカウントが見つかりません。先に申請してください。'};
  const token = await genToken(discordId);
  const url   = `${C.SITE_URL}/dashboard.html?token=${token}`;
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue).setTitle('🔑 ログインURL')
    .setDescription(`有効期限 **${C.TOKEN_EXP}分**`)
    .addFields({name:'プレイヤー',value:r.rows[0].player_name,inline:true},{name:'URL',value:url})
    .setFooter({text:'RE国際銀行 | rarala.online'}).setTimestamp();
  return await sendDM(discordId,embed) ? {ok:true} : {ok:false,error:'DMを送れませんでした。'};
}

bot.on('interactionCreate', async interaction=>{
  if(!interaction.isChatInputCommand()) return;

  if(interaction.commandName==='login'){
    await interaction.deferReply({ephemeral:true});
    const r = await sendLoginDM(interaction.user.id);
    await interaction.editReply({content: r.ok?'✅ DMにログインURLを送りました！':`❌ ${r.error}`});
  }

  if(interaction.commandName==='balance'){
    await interaction.deferReply({ephemeral:true});
    const ur = await q(`SELECT * FROM users WHERE discord_id=$1`,[interaction.user.id]);
    if(!ur.rows[0]) return interaction.editReply({content:'❌ アカウントがありません。申請してください。'});
    const user = ur.rows[0];
    const ar   = await q(`SELECT * FROM accounts WHERE discord_id=$1`,[interaction.user.id]);
    const acc  = ar.rows[0];
    const lr   = await q(`SELECT * FROM loans WHERE discord_id=$1 AND status NOT IN ('rejected','completed') ORDER BY applied_at DESC`,[interaction.user.id]);
    const loans= lr.rows;

    const embed = new EmbedBuilder().setColor(Colors.Blue).setTitle(`📊 ${user.player_name} の残高`)
      .addFields(
        {name:'口座残高',value:`${acc ? Number(acc.balance).toLocaleString() : 0} RSD`,inline:true},
        {name:'アクティブローン',value:`${loans.length} 件`,inline:true},
      ).setFooter({text:'RE国際銀行 | rarala.online'}).setTimestamp();

    if(loans.length>0){
      const ci = calcInterest(loans[0]);
      embed.addFields(
        {name:'最新ローン元金',value:`${loans[0].principal.toLocaleString()} RSD`,inline:true},
        {name:'残返済額',value:`${ci.remain.toLocaleString()} RSD`,inline:true},
        {name:'返済期限',value:ci.deadlineDate+(ci.overdue?' ⚠️':''),inline:true},
      );
    }
    await interaction.editReply({embeds:[embed]});
  }

  if(interaction.commandName==='announce'){
    await interaction.deferReply({ephemeral:true});
    if(!interaction.member?.permissions?.has('ManageGuild'))
      return interaction.editReply({content:'❌ 運営のみ使用できます。'});
    const colorMap={blue:Colors.Blue,green:Colors.Green,red:Colors.Red,gold:Colors.Gold};
    const color=interaction.options.getString('color')||'blue';
    const embed=new EmbedBuilder()
      .setColor(colorMap[color])
      .setTitle(`📢 ${interaction.options.getString('title')}`)
      .setDescription(interaction.options.getString('message'))
      .setFooter({text:`RE国際銀行 | ${interaction.user.username}`}).setTimestamp();
    await postGlobalAnnounce(embed);
    await interaction.editReply({content:'✅ お知らせを投稿しました！'});
  }
});

// ==========================================
// API
// ==========================================

// ── 設定取得（公開） ──
app.get('/api/settings', async(req,res)=>{
  await loadSettings();
  res.json({ok:true,settings:settingsCache});
});

// ── 個人ローン申請 ──
app.post('/api/apply/personal', async(req,res)=>{
  const {playerName,country,contact,plan,colAmount,screenshotUrl,loanAmount,purpose}=req.body;
  if(!playerName||!country||!contact||!plan||!colAmount||!screenshotUrl||!loanAmount||!purpose)
    return res.status(400).json({ok:false,error:'必須項目が不足しています。'});

  const discordId = contact?.match(/\d{17,20}/)?.[0];
  if(!discordId) return res.status(400).json({ok:false,error:'Discord IDが見つかりません。'});

  const principal         = Number(loanAmount);
  const collateralRequired = Math.ceil(principal * 0.5); // 貸出希望額の50%
  const colTotal          = Number(colAmount) * Number(plan);

  if(colTotal < collateralRequired)
    return res.status(400).json({ok:false,error:`担保額が不足しています。最低 ${collateralRequired.toLocaleString()} RSD 必要です（借入希望額の50%）。`});

  // アカウント作成
  await q(`INSERT INTO users (discord_id,player_name,country,contact,user_type) VALUES ($1,$2,$3,$4,'personal') ON CONFLICT (discord_id) DO NOTHING`,
    [discordId,playerName,country,contact]);
  // 口座作成
  await q(`INSERT INTO accounts (discord_id,balance) VALUES ($1,0) ON CONFLICT DO NOTHING`,[discordId]);

  const loanId   = genId('RE');
  const cycleDays= getSetting('personal_cycle_days',10);
  const rate     = getSetting('personal_rate',0.20);

  await q(`INSERT INTO loans (loan_id,discord_id,player_name,country,loan_type,plan,col_amount,col_total,screenshot_url,principal,loan_amount,collateral_required,purpose,status)
    VALUES ($1,$2,$3,$4,'personal',$5,$6,$7,$8,$9,$10,$11,$12,'pending')`,
    [loanId,discordId,playerName,country,plan,Number(colAmount),colTotal,screenshotUrl,principal,principal,collateralRequired,purpose]);

  await pushNotice(discordId,{title:'📋 申請を受け付けました',body:`申請ID: ${loanId}\n借入希望額: ${principal.toLocaleString()} RSD\n必要担保額: ${collateralRequired.toLocaleString()} RSD\n金利: ${cycleDays}日ごとに元金の${(rate*100).toFixed(0)}%\n※承認時から金利計算開始`,color:'blue',loanId});

  await sendDM(discordId, new EmbedBuilder()
    .setColor(Colors.Blue).setTitle('📋 個人ローン申請を受け付けました')
    .addFields(
      {name:'申請ID',value:loanId,inline:false},
      {name:'借入希望額',value:`${principal.toLocaleString()} RSD`,inline:true},
      {name:'必要担保額',value:`${collateralRequired.toLocaleString()} RSD`,inline:true},
      {name:'金利',value:`${cycleDays}日ごとに元金の${(rate*100).toFixed(0)}%（単利）`,inline:false},
      {name:'重要',value:'承認ボタンを押した時点から金利計算が開始されます。',inline:false},
    )
    .setDescription('審査完了（最大24時間）後にお知らせします。')
    .setFooter({text:'RE国際銀行 | rarala.online'}).setTimestamp());

  res.json({ok:true,loanId,collateralRequired});
});

// ── 国家ローン申請 ──
app.post('/api/apply/national', async(req,res)=>{
  const {playerName,country,contact,screenshotUrl,proofUrl,loanAmount,purpose}=req.body;
  if(!playerName||!country||!contact||!screenshotUrl||!proofUrl||!loanAmount||!purpose)
    return res.status(400).json({ok:false,error:'必須項目が不足しています。'});

  const principal          = Number(loanAmount);
  const minLoan            = 1000000;
  if(principal < minLoan)
    return res.status(400).json({ok:false,error:`国家ローンの最低貸出額は ${minLoan.toLocaleString()} RSD です。`});

  const collateralRequired = Math.ceil(principal * 0.5);
  const discordId          = contact?.match(/\d{17,20}/)?.[0];
  if(!discordId) return res.status(400).json({ok:false,error:'Discord IDが見つかりません。'});

  await q(`INSERT INTO users (discord_id,player_name,country,contact,user_type) VALUES ($1,$2,$3,$4,'national') ON CONFLICT (discord_id) DO NOTHING`,
    [discordId,playerName,country,contact]);
  await q(`INSERT INTO accounts (discord_id,balance) VALUES ($1,0) ON CONFLICT DO NOTHING`,[discordId]);

  const loanId = genId('REN');
  const rate   = getSetting('national_rate',0.20);
  const cycleD = getSetting('national_cycle_days',30);

  await q(`INSERT INTO loans (loan_id,discord_id,player_name,country,loan_type,col_amount,col_total,screenshot_url,proof_url,principal,loan_amount,collateral_required,purpose,status)
    VALUES ($1,$2,$3,$4,'national',0,0,$5,$6,$7,$8,$9,$10,'pending_proof')`,
    [loanId,discordId,playerName,country,screenshotUrl,proofUrl,principal,principal,collateralRequired,purpose]);

  await pushNotice(discordId,{title:'🏛️ 国家ローン申請を受け付けました',body:`申請ID: ${loanId}\n借入希望額: ${principal.toLocaleString()} RSD\n必要担保額: ${collateralRequired.toLocaleString()} RSD\n証明書審査待ちです`,color:'gold',loanId});

  await sendDM(discordId, new EmbedBuilder()
    .setColor(Colors.Gold).setTitle('🏛️ 国家ローン申請を受け付けました')
    .addFields(
      {name:'申請ID',value:loanId,inline:false},
      {name:'借入希望額',value:`${principal.toLocaleString()} RSD`,inline:true},
      {name:'必要担保額',value:`${collateralRequired.toLocaleString()} RSD`,inline:true},
      {name:'金利',value:`${cycleD}日ごとに元金の${(rate*100).toFixed(0)}%（単利）`,inline:false},
      {name:'ステータス',value:'⏳ 証明書審査待ち',inline:false},
    )
    .setDescription('運営が証明書を審査します。承認時から金利計算開始。延長は担当者相談。')
    .setFooter({text:'RE国際銀行 | rarala.online'}).setTimestamp());

  res.json({ok:true,loanId,collateralRequired});
});

// ── 延長申請 ──
app.post('/api/apply/extension', async(req,res)=>{
  const {loanId,contact,reason,desiredDays}=req.body;
  if(!loanId||!contact||!reason) return res.status(400).json({ok:false,error:'必須項目が不足しています。'});
  const lr   = await q(`SELECT * FROM loans WHERE loan_id=$1`,[loanId]);
  if(!lr.rows[0]) return res.status(404).json({ok:false,error:'申請IDが見つかりません。'});
  const discordId = contact?.match(/\d{17,20}/)?.[0];
  if(!discordId||discordId!==lr.rows[0].discord_id) return res.status(403).json({ok:false,error:'本人確認失敗。'});
  const extId = genId('EXT');
  await q(`INSERT INTO extensions (ext_id,loan_id,discord_id,reason,desired_days) VALUES ($1,$2,$3,$4,$5)`,
    [extId,loanId,discordId,reason,Number(desiredDays)||30]);
  await pushNotice(discordId,{title:'📅 延長申請を受け付けました',body:`延長申請ID: ${extId}\n対象: ${loanId}`,color:'blue',loanId});
  await sendDM(discordId, new EmbedBuilder().setColor(Colors.Blue).setTitle('📅 延長申請を受け付けました')
    .addFields({name:'延長申請ID',value:extId,inline:true},{name:'対象',value:loanId,inline:true},{name:'理由',value:reason,inline:false})
    .setFooter({text:'RE国際銀行 | rarala.online'}).setTimestamp());
  res.json({ok:true,extId});
});

// ── 認証 ──
app.post('/api/auth/request-login', async(req,res)=>{
  const {discordId}=req.body;
  if(!discordId||!/^\d{17,20}$/.test(discordId)) return res.status(400).json({ok:false,error:'正しいDiscord IDを入力してください。'});
  const r = await sendLoginDM(discordId);
  res.status(r.ok?200:400).json(r);
});

app.post('/api/auth/verify-token', async(req,res)=>{
  const {token}=req.body;
  if(!token) return res.status(400).json({ok:false,error:'トークンがありません。'});
  const r = await q(`SELECT * FROM login_tokens WHERE token=$1 AND expires_at>NOW()`,[token]);
  if(!r.rows[0]) return res.status(401).json({ok:false,error:'URLが無効か期限切れです。'});
  const discordId = r.rows[0].discord_id;
  await q(`DELETE FROM login_tokens WHERE token=$1`,[token]);
  await createSession(res, discordId);
  // ログイン時に預金金利チェック（年1回自動適用）
  applyDepositInterest(discordId).catch(()=>{});
  const ur = await q(`SELECT * FROM users WHERE discord_id=$1`,[discordId]);
  res.json({ok:true,user:ur.rows[0]});
});

app.get('/api/auth/me', async(req,res)=>{
  const user = await getUser(req);
  if(!user) return res.status(401).json({ok:false});
  res.json({ok:true,user});
});

app.post('/api/auth/logout', async(req,res)=>{
  const sid=req.signedCookies?.re_session;
  if(sid) await q(`DELETE FROM sessions WHERE session_id=$1`,[sid]);
  res.clearCookie('re_session');
  res.json({ok:true});
});

// ── 自分のローン ──
app.get('/api/loans/mine', async(req,res)=>{
  const user = await getUser(req);
  if(!user) return res.status(401).json({ok:false,error:'ログインが必要です。'});
  const r = await q(`SELECT * FROM loans WHERE discord_id=$1 ORDER BY applied_at DESC`,[user.discord_id]);
  res.json({ok:true,loans:r.rows.map(l=>({...l,calc:calcInterest(l)}))});
});

// ── 口座情報 ──
app.get('/api/account/mine', async(req,res)=>{
  const user = await getUser(req);
  if(!user) return res.status(401).json({ok:false,error:'ログインが必要です。'});
  const ar = await q(`SELECT * FROM accounts WHERE discord_id=$1`,[user.discord_id]);
  const tr = await q(`SELECT t.*,
    u1.player_name as from_name, u2.player_name as to_name
    FROM transactions t
    LEFT JOIN users u1 ON t.from_discord_id=u1.discord_id
    LEFT JOIN users u2 ON t.to_discord_id=u2.discord_id
    WHERE t.from_discord_id=$1 OR t.to_discord_id=$1
    ORDER BY t.created_at DESC LIMIT 50`,[user.discord_id]);
  res.json({ok:true,account:ar.rows[0]||{balance:0},transactions:tr.rows});
});

// ── 送金 ──
app.post('/api/account/transfer', async(req,res)=>{
  const user = await getUser(req);
  if(!user) return res.status(401).json({ok:false,error:'ログインが必要です。'});
  const {toDiscordId,amount,note}=req.body;
  if(!toDiscordId||!amount||Number(amount)<=0) return res.status(400).json({ok:false,error:'送金先とと金額を入力してください。'});
  if(toDiscordId===user.discord_id) return res.status(400).json({ok:false,error:'自分自身には送金できません。'});

  const toUser = await q(`SELECT * FROM users WHERE discord_id=$1`,[toDiscordId]);
  if(!toUser.rows[0]) return res.status(404).json({ok:false,error:'送金先のプレイヤーが見つかりません。'});

  const fromAcc = await q(`SELECT * FROM accounts WHERE discord_id=$1`,[user.discord_id]);
  if(!fromAcc.rows[0]||Number(fromAcc.rows[0].balance)<Number(amount))
    return res.status(400).json({ok:false,error:'残高が不足しています。'});

  // 送金実行
  await q(`UPDATE accounts SET balance=balance-$1 WHERE discord_id=$2`,[Number(amount),user.discord_id]);
  await q(`INSERT INTO accounts (discord_id,balance) VALUES ($1,$2) ON CONFLICT (discord_id) DO UPDATE SET balance=accounts.balance+$2`,[toDiscordId,Number(amount)]);
  const txId = genId('TX');
  await q(`INSERT INTO transactions (id,from_discord_id,to_discord_id,amount,type,note) VALUES ($1,$2,$3,$4,'transfer',$5)`,
    [txId,user.discord_id,toDiscordId,Number(amount),note||'']);

  // 双方に通知
  await pushNotice(user.discord_id,{title:'💸 送金完了',body:`${toUser.rows[0].player_name} に ${Number(amount).toLocaleString()} RSD を送金しました。`,color:'blue'});
  await pushNotice(toDiscordId,{title:'💰 入金通知',body:`${user.player_name} から ${Number(amount).toLocaleString()} RSD が入金されました。`,color:'green'});
  await sendDM(toDiscordId, new EmbedBuilder().setColor(Colors.Green).setTitle('💰 入金通知')
    .addFields({name:'送金元',value:user.player_name,inline:true},{name:'金額',value:`${Number(amount).toLocaleString()} RSD`,inline:true},{name:'メモ',value:note||'なし',inline:false})
    .setFooter({text:'RE国際銀行 | rarala.online'}).setTimestamp());

  res.json({ok:true,txId});
});

// ── 通知 ──
app.get('/api/notices/mine', async(req,res)=>{
  const user = await getUser(req);
  if(!user) return res.status(401).json({ok:false,error:'ログインが必要です。'});
  const r = await q(`SELECT * FROM notices WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 50`,[user.discord_id]);
  res.json({ok:true,notices:r.rows});
});
app.post('/api/notices/read', async(req,res)=>{
  const user = await getUser(req);
  if(!user) return res.status(401).json({ok:false});
  await q(`UPDATE notices SET read=true WHERE id=$1 AND discord_id=$2`,[req.body.id,user.discord_id]);
  res.json({ok:true});
});

// ==========================================
// 管理者API
// ==========================================
function isAdmin(req){ return req.headers['x-admin-key']===C.ADMIN_KEY; }

// ── 全ローン ──
app.get('/api/admin/loans', async(req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  await loadSettings();
  const r  = await q(`SELECT * FROM loans ORDER BY applied_at DESC`);
  const ur = await q(`SELECT COUNT(*) FROM users`);
  res.json({ok:true,loans:r.rows.map(l=>({...l,calc:calcInterest(l)})),users:Number(ur.rows[0].count),settings:settingsCache});
});

// ── ローン承認・否認・返済更新 ──
app.post('/api/admin/loans/:loanId', async(req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  const lr = await q(`SELECT * FROM loans WHERE loan_id=$1`,[req.params.loanId]);
  if(!lr.rows[0]) return res.status(404).json({ok:false,error:'申請が見つかりません。'});
  const loan = lr.rows[0];
  const {status,paidAmount,note}=req.body;

  // 承認時：approved_atを現在時刻に設定（ここから金利計算開始）
  if(status==='approved'){
    await q(`UPDATE loans SET status='approved', approved_at=NOW(), note=COALESCE($1,note) WHERE loan_id=$2`,
      [note||null, loan.loan_id]);
    // 口座に貸出額を入金
    await q(`INSERT INTO accounts (discord_id,balance) VALUES ($1,$2) ON CONFLICT (discord_id) DO UPDATE SET balance=accounts.balance+$2`,
      [loan.discord_id, loan.principal]);
    // 入金トランザクション記録
    await q(`INSERT INTO transactions (id,from_discord_id,to_discord_id,amount,type,note) VALUES ($1,NULL,$2,$3,'deposit','ローン承認による入金')`,
      [genId('TX'),loan.discord_id,loan.principal]);
  } else {
    await q(`UPDATE loans SET status=COALESCE($1,status), paid_amount=COALESCE($2,paid_amount), note=COALESCE($3,note) WHERE loan_id=$4`,
      [status||null, paidAmount!==undefined?Number(paidAmount):null, note||null, loan.loan_id]);
  }

  const updated = (await q(`SELECT * FROM loans WHERE loan_id=$1`,[loan.loan_id])).rows[0];
  const ci      = calcInterest(updated);

  const cfgs = {
    approved:     {color:Colors.Green,  dmTitle:'✅ ローンが承認されました！',     dmBody:`${loan.principal.toLocaleString()} RSD を口座に入金しました。\n返済は本店SHOPで。\n※本日より金利計算が開始されます。`,noticeColor:'green'},
    rejected:     {color:Colors.Red,    dmTitle:'❌ 申請が否認されました',          dmBody:`理由: ${note||'記載なし'}\n担保はゲーム内で返却します。`,noticeColor:'red'},
    repaying:     {color:Colors.Yellow, dmTitle:'💸 返済を確認しました',            dmBody:`返済済み: ${(paidAmount||0).toLocaleString()} RSD\n残返済額: ${ci.remain.toLocaleString()} RSD`,noticeColor:'blue'},
    completed:    {color:Colors.Gold,   dmTitle:'🎉 完済しました！',                dmBody:'担保をゲーム内で返却します。ありがとうございました！',noticeColor:'green'},
    pending_proof:{color:Colors.Blue,   dmTitle:'📋 証明書を受け付けました',        dmBody:'運営が審査します。',noticeColor:'blue'},
  };

  const cfg = cfgs[status];
  if(cfg){
    await sendDM(loan.discord_id, new EmbedBuilder().setColor(cfg.color).setTitle(cfg.dmTitle).setDescription(cfg.dmBody)
      .addFields({name:'申請ID',value:loan.loan_id,inline:true})
      .setFooter({text:'RE国際銀行 | rarala.online'}).setTimestamp());
    await pushNotice(loan.discord_id,{title:cfg.dmTitle,body:cfg.dmBody,color:cfg.noticeColor,loanId:loan.loan_id});
  }
  res.json({ok:true,loan:{...updated,calc:ci}});
});

// ── 延長申請一覧 ──
app.get('/api/admin/extensions', async(req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  const r = await q(`SELECT * FROM extensions ORDER BY applied_at DESC`);
  res.json({ok:true,extensions:r.rows});
});

// ── 延長申請処理 ──
app.post('/api/admin/extensions/:extId', async(req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  const er = await q(`SELECT * FROM extensions WHERE ext_id=$1`,[req.params.extId]);
  if(!er.rows[0]) return res.status(404).json({ok:false});
  const {approved,addDays,note}=req.body;
  await q(`UPDATE extensions SET status=$1, note=$2 WHERE ext_id=$3`,[approved?'approved':'rejected',note||'',er.rows[0].ext_id]);
  if(approved&&addDays)
    await q(`UPDATE loans SET deadline_extended=COALESCE(deadline_extended,0)+$1 WHERE loan_id=$2`,[Number(addDays),er.rows[0].loan_id]);
  const msg = approved?`延長承認: ${addDays}日延長`:`延長否認: ${note||'記載なし'}`;
  await pushNotice(er.rows[0].discord_id,{title:approved?'📅 延長承認':'📅 延長否認',body:msg,color:approved?'green':'red',loanId:er.rows[0].loan_id});
  await sendDM(er.rows[0].discord_id, new EmbedBuilder().setColor(approved?Colors.Green:Colors.Red)
    .setTitle(approved?'📅 延長申請が承認されました':'📅 延長申請が否認されました').setDescription(msg)
    .setFooter({text:'RE国際銀行 | rarala.online'}).setTimestamp());
  res.json({ok:true});
});

// ── 設定変更（金利など） ──
app.get('/api/admin/settings', async(req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  await loadSettings();
  res.json({ok:true,settings:settingsCache});
});

app.post('/api/admin/settings', async(req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  const updates = req.body; // { key: value, ... }
  // rate系のキーは%入力（例:2）→小数（0.02）に変換して保存
  const rateKeys = ['personal_rate','national_rate','deposit_rate'];
  for(const [key,value] of Object.entries(updates)){
    let saveVal = String(value);
    if(rateKeys.includes(key)){
      // 1より大きい値は%として入力されたとみなし÷100する
      const num = Number(value);
      saveVal = (num > 1 ? (num / 100) : num).toFixed(6);
    }
    await q(`INSERT INTO settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,[key,saveVal]);
  }
  await loadSettings();
  res.json({ok:true,settings:settingsCache});
});

// ── 全ユーザー一覧 ──
app.get('/api/admin/users', async(req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  const r = await q(`SELECT u.*, a.balance FROM users u LEFT JOIN accounts a ON u.discord_id=a.discord_id ORDER BY u.created_at DESC`);
  res.json({ok:true,users:r.rows});
});

// ── 手動お知らせ ──
app.post('/api/admin/announce', async(req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  const {title,message,color,targetDiscordId}=req.body;
  if(!message) return res.status(400).json({ok:false,error:'messageが必要です。'});
  const colorMap={blue:Colors.Blue,green:Colors.Green,red:Colors.Red,gold:Colors.Gold};
  const embed = new EmbedBuilder().setColor(colorMap[color]||Colors.Blue)
    .setTitle(`📢 ${title||'RE国際銀行 お知らせ'}`).setDescription(message)
    .setFooter({text:'RE国際銀行 | rarala.online'}).setTimestamp();
  if(targetDiscordId){
    await pushNotice(targetDiscordId,{title:title||'お知らせ',body:message,color:color||'blue'});
    await sendDM(targetDiscordId,embed);
    res.json({ok:true,type:'personal'});
  } else {
    await postGlobalAnnounce(embed);
    res.json({ok:true,type:'global'});
  }
});

// ==========================================
// 起動
// ==========================================
app.listen(PORT, async()=>{
  console.log(`🚀 サーバー起動 → http://localhost:${PORT}`);
  await loadSettings();
});
bot.login(C.BOT_TOKEN);
