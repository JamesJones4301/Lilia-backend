import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import pkg from "pg";
import { stringify } from "csv-stringify/sync";
import axios from "axios";

dotenv.config();
const { Pool } = pkg;

const {
  PORT = 8080,
  DATABASE_URL,
  ADMIN_PASSWORD = "lilia#2024",
  FORWARD_TO_APPSCRIPT_URL // optional: keep your Google Sheets workflow in parallel
} = process.env;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is required. Set it in Railway/Render variables.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "connect-src": ["'self'"], // same-origin API
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
        "img-src": ["'self'", "data:", "https:"]
      }
    }
  })
);
app.use(morgan("tiny"));
app.use(express.json());

// ---------- DB bootstrap ----------
async function init() {
  await pool.query(`
    create table if not exists donations (
      id bigserial primary key,
      amount integer not null,
      numbers text not null,
      method text not null,
      donor_name text not null,
      donor_phone text not null,
      donor_address text not null,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists state (
      id int primary key default 1,
      goal integer not null default 3500,
      bio text not null default 'I''m passionate about serving others and making a difference in the lives of children. This Tanzania mission is close to my heart!'
    );
  `);

  await pool.query(`insert into state (id) values (1) on conflict (id) do nothing;`);
}

function isAuthed(req) {
  return (req.headers["x-admin-key"] || "") === ADMIN_PASSWORD;
}

// ---------- API ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/state", async (_req, res, next) => {
  try {
    const [{ rows: totals }, { rows: taken }, { rows: st }] = await Promise.all([
      pool.query("select coalesce(sum(amount),0)::int as raised, count(*)::int as donations from donations"),
      pool.query(`
        with e as (select unnest(string_to_array(numbers, ','))::int n from donations)
        select n from e group by n
      `),
      pool.query("select goal, bio from state where id=1")
    ]);

    res.json({
      raised: totals[0].raised,
      donationCount: totals[0].donations,
      goal: st[0]?.goal ?? 3500,
      bio: st[0]?.bio ?? "",
      takenNumbers: taken.map(r => r.n)
    });
  } catch (e) { next(e); }
});

app.post("/api/donations", async (req, res, next) => {
  try {
    const { amount, numbers, method, donorName, donorPhone, donorAddress } = req.body || {};
    if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: "numbers[] required" });
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: "invalid amount" });
    if (!["venmo","cashapp","paypal","zelle","manual"].includes(method)) return res.status(400).json({ error: "invalid method" });
    if (!donorName || !donorPhone || !donorAddress) return res.status(400).json({ error: "donor info required" });

    // conflict check
    const q = await pool.query(`
      with e as (select unnest(string_to_array(numbers, ','))::int n from donations)
      select n from e where n = any($1::int[])
    `, [numbers]);
    const already = new Set(q.rows.map(r => r.n));
    const conflicts = numbers.filter(n => already.has(n));
    if (conflicts.length) return res.status(409).json({ error: "numbers already taken", conflicts });

    // save
    const csv = numbers.join(",");
    await pool.query(
      `insert into donations (amount, numbers, method, donor_name, donor_phone, donor_address)
       values ($1,$2,$3,$4,$5,$6)`,
      [amount, csv, method, donorName, donorPhone, donorAddress]
    );

    // optional forward to Apps Script
    if (FORWARD_TO_APPSCRIPT_URL) {
      try {
        await axios.post(FORWARD_TO_APPSCRIPT_URL, {
          amount, numbers: csv, method, donorName, donorPhone, donorAddress,
          date: new Date().toLocaleDateString(), timestamp: Date.now()
        });
      } catch (e) { console.warn("Apps Script forward failed:", e?.response?.status || e.message); }
    }

    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

app.get("/api/export.csv", async (req, res, next) => {
  try {
    if (!isAuthed(req)) return res.status(401).json({ error: "unauthorized" });
    const { rows } = await pool.query(`select * from donations order by id desc`);
    const out = rows.map(r => ({
      id: r.id, amount: r.amount, numbers: r.numbers, method: r.method,
      donor_name: r.donor_name, donor_phone: r.donor_phone, donor_address: r.donor_address,
      created_at: r.created_at
    }));
    const csv = stringify(out, { header: true });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"donations.csv\""); 
    res.send(csv);
  } catch (e) { next(e); }
});

app.post("/api/admin/state", async (req, res, next) => {
  try {
    if (!isAuthed(req)) return res.status(401).json({ error: "unauthorized" });
    const { bio, goal } = req.body || {};
    if (bio !== undefined) await pool.query(`update state set bio=$1 where id=1`, [String(bio)]);
    if (goal !== undefined) await pool.query(`update state set goal=$1 where id=1`, [parseInt(goal, 10) || 3500]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Frontend (HTML served inline) ----------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Help Lilia Get to Tanzania - Mission Trip Fundraiser</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&family=Dancing+Script:wght@600&display=swap" rel="stylesheet">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  connect-src 'self';
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com;
  font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:;
  img-src 'self' data: https:;
">
<meta http-equiv="X-Content-Type-Options" content="nosniff">
<meta http-equiv="X-XSS-Protection" content="1; mode=block">
<style>
  :root { --primary:#8e44ad; --primary-light:#9b59b6; --secondary:#e84393; --accent:#3498db; --success:#2ecc71; --light:#f8f9fa; --dark:#2c3e50; --text:#555; --shadow:0 10px 30px rgba(0,0,0,0.1); --transition:all 0.3s ease }
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Poppins',sans-serif;background:linear-gradient(135deg,#f5f7fa 0%,#c3cfe2 100%);min-height:100vh;color:var(--text);line-height:1.6}
  .container{max-width:900px;margin:0 auto;padding:20px}
  .header{text-align:center;background:#fff;padding:40px;border-radius:15px;margin-bottom:30px;box-shadow:var(--shadow);position:relative;overflow:hidden}
  .header::before{content:"";position:absolute;top:0;left:0;width:100%;height:8px;background:linear-gradient(90deg,var(--primary),var(--secondary))}
  .header h1{font-size:2.8rem;color:var(--primary);margin-bottom:10px;font-weight:700}
  .header h2{color:var(--secondary);font-size:1.5rem;margin-bottom:25px;font-weight:500}
  .mission-info{background:#f8f9fa;padding:25px;border-radius:10px;margin:25px 0;position:relative;border-left:4px solid var(--accent)}
  .mission-info h3{color:var(--primary);margin-bottom:15px;font-size:1.5rem;display:flex;align-items:center;gap:10px}
  .mission-info h3 i{color:var(--secondary)}
  .mission-info p{margin-bottom:15px}
  .highlight-box{background:linear-gradient(135deg,rgba(142,68,173,0.1),rgba(232,67,147,0.1));padding:15px;border-radius:8px;margin-top:15px;border:1px dashed var(--primary)}
  .admin-panel{background:#fff;padding:20px;border-radius:15px;margin-bottom:30px;box-shadow:var(--shadow);border-top:4px solid var(--primary)}
  .admin-toggle{background:linear-gradient(135deg,var(--primary),var(--primary-light));color:#fff;padding:12px 25px;border:none;border-radius:50px;cursor:pointer;font-size:16px;font-weight:600;margin-bottom:20px;display:flex;align-items:center;gap:10px;width:fit-content;transition:var(--transition)}
  .admin-toggle:hover{transform:translateY(-3px);box-shadow:0 5px 15px rgba(142,68,173,0.3)}
  .admin-content{display:none;padding-top:20px;border-top:1px solid #eee}
  .admin-content.active{display:block}
  .form-group{margin-bottom:20px}
  .form-group label{display:block;margin-bottom:8px;font-weight:600;color:var(--dark);display:flex;align-items:center;gap:8px}
  .form-group textarea,.form-group input{width:100%;padding:12px 15px;border:1px solid #ddd;border-radius:8px;font-size:16px;font-family:'Poppins',sans-serif;transition:var(--transition)}
  .form-group textarea:focus,.form-group input:focus{border-color:var(--primary);outline:0;box-shadow:0 0 0 3px rgba(142,68,173,0.2)}
  .form-group textarea{min-height:120px;resize:vertical}
  .fundraiser-card{background:#fff;border-radius:15px;padding:40px;box-shadow:var(--shadow);margin-bottom:30px;position:relative;overflow:hidden}
  .fundraiser-card.completed{background:linear-gradient(135deg,var(--success),#27ae60);color:#fff}
  .fundraiser-header{text-align:center;margin-bottom:30px}
  .profile-container{display:flex;justify-content:center;margin-bottom:20px}
  .profile-image{width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--secondary));display:flex;align-items:center;justify-content:center;color:#fff;font-size:3rem;font-weight:600;border:5px solid #fff;box-shadow:0 5px 15px rgba(0,0,0,0.1)}
  .fundraiser-name{font-size:2.5rem;font-weight:700;margin-bottom:15px;color:var(--primary);cursor:pointer;font-family:'Dancing Script',cursive}
  .fundraiser-bio{color:var(--text);font-size:1.1rem;margin-bottom:30px;line-height:1.8;max-width:700px;margin-left:auto;margin-right:auto;font-style:italic}
  .progress-section{margin-bottom:30px;background:#f8f9fa;padding:25px;border-radius:12px}
  .progress-bar{width:100%;height:25px;background:#ecf0f1;border-radius:15px;overflow:hidden;margin-bottom:15px;box-shadow:inset 0 2px 5px rgba(0,0,0,0.1)}
  .progress-fill{height:100%;background:linear-gradient(90deg,var(--primary),var(--secondary));transition:width 0.5s ease;border-radius:15px;position:relative;overflow:hidden}
  .progress-fill::after{content:"";position:absolute;top:0;left:-100%;width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent);animation:progressShine 2s infinite}
  @keyframes progressShine{100%{left:100%}}
  .progress-text{text-align:center;font-weight:700;font-size:1.3rem;margin-bottom:8px;color:var(--dark)}
  .progress-percentage{text-align:center;font-size:1.1rem;color:var(--primary);font-weight:600}
  .number-section{background:#f8f9fa;padding:25px;border-radius:12px;margin-bottom:30px}
  .section-title{font-size:1.4rem;color:var(--primary);margin-bottom:20px;display:flex;align-items:center;gap:10px}
  .number-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:10px;margin-bottom:25px}
  .number-button{aspect-ratio:1;border:2px solid var(--accent);background:#fff;color:var(--accent);border-radius:10px;cursor:pointer;font-weight:700;transition:var(--transition);display:flex;align-items:center;justify-content:center;font-size:1.1rem;box-shadow:0 3px 6px rgba(0,0,0,0.05)}
  .number-button:hover{background:var(--accent);color:#fff;transform:translateY(-3px);box-shadow:0 5px 15px rgba(52,152,219,0.3)}
  .number-button.selected{background:var(--success);border-color:var(--success);color:#fff;transform:scale(1.05)}
  .number-button.donated{background:#bdc3c7;border-color:#95a5a6;color:#fff;cursor:not-allowed;transform:none}
  .donation-summary{background:linear-gradient(135deg,rgba(142,68,173,0.1),rgba(232,67,147,0.1));padding:20px;border-radius:10px;margin-bottom:25px;text-align:center;border:1px solid var(--primary-light)}
  .donation-summary h3{font-size:1.5rem;color:var(--primary)}
  .payment-methods{display:grid;grid-template-columns:repeat(2,1fr);gap:15px;margin-bottom:30px}
  .payment-btn{padding:20px 15px;border:2px solid #e0e0e0;background:#fff;border-radius:12px;cursor:pointer;font-weight:600;transition:var(--transition);text-align:center;font-size:1.1rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
  .payment-btn:hover{border-color:var(--accent);background:#f8f9fa;transform:translateY(-3px)}
  .payment-btn.selected{border-color:var(--success);background:var(--success);color:#fff;transform:scale(1.02)}
  .payment-icon{font-size:2rem}
  .donate-btn{width:100%;padding:18px;background:linear-gradient(135deg,var(--primary),var(--secondary));color:#fff;border:none;border-radius:12px;font-size:1.3rem;font-weight:700;cursor:pointer;transition:var(--transition);box-shadow:0 5px 15px rgba(142,68,173,0.3);letter-spacing:0.5px}
  .donate-btn:hover{transform:translateY(-3px);box-shadow:0 8px 20px rgba(142,68,173,0.4)}
  .donate-btn:disabled{background:#bdc3c7;cursor:not-allowed;transform:none;box-shadow:none}
  .modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:1000;overflow-y:auto}
  .modal-content{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:40px;border-radius:20px;max-width:550px;width:90%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.3)}
  .close-btn{position:absolute;top:20px;right:25px;font-size:30px;cursor:pointer;color:#999;transition:var(--transition)}
  .close-btn:hover{color:var(--primary);transform:rotate(90deg)}
  .success-message{background:linear-gradient(135deg,var(--success),#27ae60);color:#fff;padding:20px;border-radius:10px;margin:20px 0;text-align:center;font-size:1.2rem}
  .status-indicator{padding:12px;border-radius:8px;margin:15px 0;text-align:center;font-weight:600}
  .status-success{background:#d4edda;color:#155724;border:1px solid #c3e6cb}
  .status-error{background:#f8d7da;color:#721c24;border:1px solid #f5c6cb}
  .auth-form{background:#fff3cd;border:1px solid #ffeeba;padding:25px;border-radius:12px;margin:20px 0}
  .form-btn{padding:12px 25px;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:var(--transition);width:100%;margin-top:10px}
  .btn-primary{background:linear-gradient(135deg,var(--primary),var(--primary-light))}
  .btn-danger{background:linear-gradient(135deg,#e74c3c,#c0392b)}
  .btn-success{background:linear-gradient(135deg,var(--success),#27ae60)}
  @media (max-width:768px){.container{padding:15px}.header{padding:30px 20px}.header h1{font-size:2.2rem}.number-grid{grid-template-columns:repeat(5,1fr)}.payment-methods{grid-template-columns:1fr}.fundraiser-card{padding:30px 20px}.modal-content{padding:30px 20px}}
  @media (max-width:480px){.number-grid{grid-template-columns:repeat(4,1fr)}.header h1{font-size:1.8rem}.header h2{font-size:1.2rem}}
  .floating-element{position:absolute;z-index:-1;opacity:0.1}
  .floating-1{top:10%;left:5%;font-size:5rem;color:var(--primary);animation:float 15s infinite linear}
  .floating-2{top:20%;right:5%;font-size:4rem;color:var(--secondary);animation:float 18s infinite linear reverse}
  .floating-3{bottom:20%;left:10%;font-size:3.5rem;color:var(--accent);animation:float 12s infinite linear}
  @keyframes float{0%{transform:translateY(0) rotate(0)}50%{transform:translateY(-20px) rotate(180deg)}100%{transform:translateY(0) rotate(360deg)}}
</style>
</head>
<body>
  <div class="floating-element floating-1"><i class="fas fa-heart"></i></div>
  <div class="floating-element floating-2"><i class="fas fa-globe-africa"></i></div>
  <div class="floating-element floating-3"><i class="fas fa-hands-helping"></i></div>

  <div class="container">
    <div class="header">
      <h1><i class="fas fa-globe-africa"></i> Help Lilia Get to Tanzania</h1>
      <h2>Mission Trip to Arusha • November 20-30, 2025</h2>
      <div class="mission-info">
        <h3><i class="fas fa-bullseye"></i> Our Mission</h3>
        <p>We'll be ministering to over 107,000 children in Arusha, Tanzania and conducting projects at a local school (possibly painting classrooms, fixing desks, and other vital improvements to create a better learning environment).</p>
        <p><strong>Your donation helps cover:</strong> Flights, accommodation, meals, project supplies, and materials for the children.</p>
        <div class="highlight-box">
          <p><strong><i class="fas fa-lightbulb"></i> How to Donate:</strong> "Pick A Number" to represent the donation amount that you would like to give (you can choose multiple numbers to get the sum of your choice). Afterwards, scroll to the bottom to select payment option and press "Next".</p>
        </div>
      </div>
    </div>

    <div class="admin-panel" id="adminPanel" style="display:none;">
      <button class="admin-toggle" onclick="toggleAdmin()"><i class="fas fa-tools"></i> Admin Panel</button>
      <div class="admin-content" id="adminContent">
        <h3><i class="fas fa-user-shield"></i> Admin Dashboard - Lilia</h3>
        <div class="auth-form" id="authForm">
          <h4><i class="fas fa-lock"></i> Admin Authentication Required</h4>
          <div class="form-group">
            <label><i class="fas fa-key"></i> Admin Password:</label>
            <input type="password" id="adminPassword" placeholder="Enter admin password">
            <button class="form-btn btn-primary" onclick="authenticateAdmin()"><i class="fas fa-unlock"></i> Unlock Admin Panel</button>
          </div>
          <div id="authError" class="status-indicator status-error" style="display:none;"></div>
        </div>

        <div id="adminDashboard" style="display:none;">
          <div class="form-group">
            <label><i class="fas fa-chart-line"></i> Stats</label>
            <p><strong>Total Donations:</strong> <span id="donationCount">— (use CSV export)</span></p>
            <p><strong>Total Raised:</strong> $<span id="totalRaised">0</span></p>
            <p><strong>Last Updated:</strong> <span id="lastUpdated">Never</span></p>
          </div>

          <div class="form-group">
            <label><i class="fas fa-edit"></i> Update Your Bio</label>
            <textarea id="bioText" maxlength="500">I'm passionate about serving others and making a difference in the lives of children. This Tanzania mission is close to my heart!</textarea>
            <button class="form-btn btn-primary" onclick="updateBio()"><i class="fas fa-save"></i> Update Bio</button>
          </div>

          <div class="form-group">
            <label><i class="fas fa-tag"></i> Mark Numbers as Donated</label>
            <input type="text" id="manualNumbers" placeholder="Enter numbers separated by commas (e.g., 9,15,23)" style="margin-bottom:10px;" maxlength="200">
            <button class="form-btn btn-danger" onclick="markNumbersAsDonated()"><i class="fas fa-check-circle"></i> Mark as Donated</button>
          </div>

          <div style="display:flex;gap:15px;flex-wrap:wrap;margin-top:30px;">
            <button class="form-btn btn-primary" onclick="downloadDonorData()" style="width:auto;padding:15px 25px;"><i class="fas fa-download"></i> Download CSV</button>
            <button class="form-btn btn-danger" onclick="resetAllData()" style="width:auto;padding:15px 25px;"><i class="fas fa-trash-alt"></i> Reset All Data</button>
          </div>
        </div>
      </div>
    </div>

    <div class="fundraiser-card" id="fundraiserCard">
      <div class="fundraiser-header">
        <div class="profile-container"><div class="profile-image">L</div></div>
        <div class="fundraiser-name">Lilia</div>
        <div class="fundraiser-bio" id="bioDisplay">I'm passionate about serving others and making a difference in the lives of children. This Tanzania mission is close to my heart!</div>
      </div>

      <div class="progress-section">
        <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
        <div class="progress-text" id="progressText">$0 / $3,500</div>
        <div class="progress-percentage" id="progressPercentage">0% to goal</div>
      </div>

      <div class="number-section">
        <h3 class="section-title"><i class="fas fa-hashtag"></i> Pick Your Number(s)</h3>
        <div class="number-grid" id="numberGrid"></div>
      </div>

      <div class="donation-summary" id="donationSummary"><h3>Selected Amount: $0</h3></div>

      <div class="payment-methods">
        <div class="payment-btn" onclick="openVenmo()">💜 Venmo</div>
        <div class="payment-btn" onclick="openCashApp()">💚 CashApp</div>
        <div class="payment-btn" onclick="openPayPal('https://www.paypal.com/donate/?hosted_button_id=SKVSD3FNPFCAG')">💙 PayPal</div>
        <div class="payment-btn" onclick="openGoFundMe('https://gofund.me/6a5d7faa')">💙 GoFundMe https://gofund.me/6a5d7faa</div>
      </div>

      <button class="donate-btn" onclick="processDonation()" disabled id="donateBtn"><i class="fas fa-arrow-right"></i> Next</button>
    </div>
  </div>

  <div class="modal" id="paymentModal">
    <div class="modal-content">
      <span class="close-btn" onclick="closeModal()">&times;</span>
      <h2><i class="fas fa-gift"></i> Complete Your Donation</h2>
      <div id="paymentInfo"></div>

      <div style="background:#f8f9fa;padding:25px;border-radius:12px;margin:30px 0;text-align:left;">
        <h4 style="margin-bottom:20px;text-align:center;color:var(--primary);"><i class="fas fa-user-circle"></i> Donor Information</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
          <div>
            <label style="display:block;margin-bottom:8px;font-weight:600;color:var(--dark);">Full Name *</label>
            <input type="text" id="donorName" required style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:'Poppins',sans-serif;">
          </div>
          <div>
            <label style="display:block;margin-bottom:8px;font-weight:600;color:var(--dark);">Phone Number *</label>
            <input type="tel" id="donorPhone" required style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:'Poppins',sans-serif;">
          </div>
        </div>
        <div>
          <label style="display:block;margin-bottom:8px;font-weight:600;color:var(--dark);">Mailing Address *</label>
          <textarea id="donorAddress" required rows="3" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:'Poppins',sans-serif;" placeholder="Street Address, City, State, ZIP"></textarea>
        </div>
      </div>

      <p style="margin-top:20px;color:var(--text);"><i class="fas fa-info-circle"></i> After sending payment and filling out your information, click the button below.</p>
      <button class="form-btn btn-success" onclick="confirmDonation()" id="confirmBtn"><i class="fas fa-check"></i> I've Sent Payment</button>
    </div>
  </div>

  <script>
    const ADMIN_PASSWORD = 'lilia#2024'; // UI gate only; real auth is server-side via x-admin-key
    const API_BASE = ""; // same-origin

    async function apiGetState() {
      const r = await fetch(\`\${API_BASE}/api/state\`);
      if (!r.ok) throw new Error("Failed to load state");
      return r.json();
    }
    async function apiDonate(donation) {
      const r = await fetch(\`\${API_BASE}/api/donations\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(donation)
      });
      if (!r.ok) {
        const err = await r.json().catch(()=>({}));
        throw new Error(err.error || "Donation failed");
      }
      return r.json();
    }
    async function apiExportCSV() {
      const r = await fetch(\`\${API_BASE}/api/export.csv\`, { headers: { "x-admin-key": ADMIN_PASSWORD } });
      if (!r.ok) throw new Error("Unauthorized or error fetching CSV");
      return r.blob();
    }
    async function apiUpdateState(partial) {
      const r = await fetch(\`\${API_BASE}/api/admin/state\`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_PASSWORD },
        body: JSON.stringify(partial)
      });
      if (!r.ok) throw new Error("Failed to update state");
      return r.json();
    }

    let fundraiserData = { name: "Lilia", bio: "I'm passionate about serving others and making a difference in the lives of children. This Tanzania mission is close to my heart!", raised: 0, goal: 3500, donations: {}, completed: false };
    let selectedNumbers = [], selectedPayment = '', tapCount = 0, isAuthenticated = false;

    function sanitizeInput(input){ if(typeof input!=='string')return ''; return input.replace(/[<>"'&]/g,m=>({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;','&':'&amp;'}[m])).trim(); }

    function authenticateAdmin(){
      const password=document.getElementById('adminPassword').value;
      const authError=document.getElementById('authError');
      if(password===ADMIN_PASSWORD){
        isAuthenticated=true;
        document.getElementById('authForm').style.display='none';
        document.getElementById('adminDashboard').style.display='block';
        document.getElementById('adminPassword').value='';
        updateAdminStats();
      }else{
        authError.textContent='Invalid admin password';
        authError.style.display='block';
        setTimeout(()=>authError.style.display='none',3000);
      }
    }

    async function init(){
      try{
        const s=await apiGetState();
        fundraiserData.raised=s.raised; fundraiserData.goal=s.goal; fundraiserData.bio=s.bio;
        fundraiserData.donations={}; s.takenNumbers.forEach(n=>fundraiserData.donations[n]=true);
        generateNumberGrid(); updateProgress(); updateDonationSummary(); setupMobileAdminAccess();
      }catch(e){ console.error(e); alert("Could not load fundraiser state."); }
    }

    function generateNumberGrid(){
      const grid=document.getElementById('numberGrid'); grid.innerHTML='';
      for(let i=1;i<=80;i++){
        const b=document.createElement('div'); b.className='number-button'; b.textContent=i; b.title=\`Donate $\${i}\`;
        if(fundraiserData.donations[i]){ b.classList.add('donated'); b.style.pointerEvents='none'; }
        else if(selectedNumbers.includes(i)){ b.classList.add('selected'); }
        b.onclick=()=>toggleNumber(i); grid.appendChild(b);
      }
    }
    function toggleNumber(n){
      if(fundraiserData.donations[n])return;
      const i=selectedNumbers.indexOf(n);
      if(i>-1)selectedNumbers.splice(i,1); else selectedNumbers.push(n);
      generateNumberGrid(); updateDonationSummary();
    }
    function updateDonationSummary(){
      const total=selectedNumbers.reduce((s,n)=>s+n,0);
      document.getElementById('donationSummary').innerHTML=\`<h3>Selected Amount: $\${total}</h3>\`;
      const donateBtn=document.getElementById('donateBtn');
      if(selectedNumbers.length===0||!selectedPayment){ donateBtn.innerHTML='<i class="fas fa-arrow-right"></i> Next'; donateBtn.disabled=true; }
      else { donateBtn.innerHTML=\`<i class="fas fa-arrow-right"></i> Next ($\${total})\`; donateBtn.disabled=false; }
    }
    function updateProgress(){
      const pct=Math.min((fundraiserData.raised/fundraiserData.goal)*100,100);
      document.getElementById('progressFill').style.width=\`\${pct}%\`;
      document.getElementById('progressText').textContent=\`$\${fundraiserData.raised} / $\${fundraiserData.goal.toLocaleString()}\`;
      document.getElementById('progressPercentage').textContent=\`\${Math.round(pct)}% to goal\`;
      document.getElementById('bioDisplay').textContent=fundraiserData.bio;
      if(fundraiserData.raised>=fundraiserData.goal){
        document.getElementById('fundraiserCard').classList.add('completed');
        document.getElementById('numberGrid').style.display='none';
        document.querySelector('.payment-methods').style.display='none';
        document.getElementById('donateBtn').style.display='none';
        document.getElementById('donationSummary').innerHTML='<div class="success-message">🎉 Goal Reached! Thank you for helping Lilia get to Tanzania!</div>';
      }
    }
    function selectPayment(method,el){
      selectedPayment=method;
      document.querySelectorAll('.payment-btn').forEach(btn=>btn.classList.remove('selected'));
      if(el) el.classList.add('selected');
      updateDonationSummary();
    }
    function openVenmo(){ window.open('https://venmo.com/Lilia-Jones-2','_blank'); selectPayment('venmo',event.currentTarget); }
    function openCashApp(){ window.open('https://cash.app/$itsliliuh','_blank'); selectPayment('cashapp',event.currentTarget); }
    function openPayPal(url){ window.open(url,'_blank'); selectPayment('paypal',event.currentTarget); }
    function openGoFundMe(url){ window.open(url,'_blank'); }
    function processDonation(){
      if(selectedNumbers.length===0||!selectedPayment)return;
      const total=selectedNumbers.reduce((s,n)=>s+n,0); showPaymentModal(selectedPayment,total);
    }
    function showPaymentModal(method,amount){
      const modal=document.getElementById('paymentModal'); const info=document.getElementById('paymentInfo');
      const methods={venmo:{handle:'@Lilia-Jones-2',name:'Venmo'},cashapp:{handle:'$itsliliuh',name:'CashApp'},paypal:{handle:'Use PayPal link',name:'PayPal'},zelle:{handle:'512-585-0543',name:'Zelle'}};
      const p=methods[method]; if(!p) return;
      info.innerHTML=\`
        <h3 style="color: var(--primary);">Send $\${amount} to Lilia</h3>
        <p style="margin: 15px 0; font-size: 1.1rem;"><strong>\${p.name}:</strong> \${p.handle}</p>
        <p style="margin-bottom: 20px;"><strong>Memo:</strong> Tanzania Mission Trip</p>
        <div style="background:#f0f5ff;padding:20px;border-radius:10px;margin:25px 0;border-left:4px solid var(--accent);">
          <p style="font-size:1.1rem;">Please send <strong>$\${amount}</strong> using \${p.name}</p>
        </div>\`;
      modal.style.display='block';
    }
    async function confirmDonation(){
      const donorName=sanitizeInput(document.getElementById('donorName').value);
      const donorPhone=sanitizeInput(document.getElementById('donorPhone').value);
      const donorAddress=sanitizeInput(document.getElementById('donorAddress').value);
      if(!donorName||!donorPhone||!donorAddress){ alert('Please fill out all donor information fields.'); return; }
      const total=selectedNumbers.reduce((s,n)=>s+n,0);
      try{
        await apiDonate({ amount: total, numbers: selectedNumbers, method: selectedPayment, donorName, donorPhone, donorAddress });
        alert(\`Thank you for your donation of $\${total}!\`);
        selectedNumbers=[]; selectedPayment=''; document.getElementById('donorName').value=''; document.getElementById('donorPhone').value=''; document.getElementById('donorAddress').value=''; closeModal();
        const s=await apiGetState(); fundraiserData.raised=s.raised; fundraiserData.goal=s.goal; fundraiserData.bio=s.bio; fundraiserData.donations={}; s.takenNumbers.forEach(n=>fundraiserData.donations[n]=true);
        generateNumberGrid(); updateProgress(); updateDonationSummary();
      }catch(e){ alert(e.message||"Donation failed"); }
    }
    function closeModal(){ document.getElementById('paymentModal').style.display='none'; }

    function setupMobileAdminAccess(){
      const el=document.querySelector('.fundraiser-name');
      el.addEventListener('click', function(){
        tapCount++; if(tapCount===7){ const adminPanel=document.getElementById('adminPanel'); adminPanel.style.display=adminPanel.style.display==='none'?'block':'none'; tapCount=0; this.style.color='#e84393'; setTimeout(()=>this.style.color='#8e44ad',1000); }
        setTimeout(()=>{ tapCount=0; },3000);
      });
    }
    function toggleAdmin(){ document.getElementById('adminContent').classList.toggle('active'); }
    function updateAdminStats(){ if(!isAuthenticated) return; document.getElementById('donationCount').textContent='— (use CSV export)'; document.getElementById('totalRaised').textContent=fundraiserData.raised; document.getElementById('lastUpdated').textContent=new Date().toLocaleString(); }
    async function updateBio(){
      if(!isAuthenticated) return;
      const newBio=sanitizeInput(document.getElementById('bioText').value);
      try{ await apiUpdateState({ bio:newBio }); fundraiserData.bio=newBio; document.getElementById('bioDisplay').textContent=newBio;
        const msg=document.createElement('div'); msg.className='status-indicator status-success'; msg.innerHTML='<i class="fas fa-check-circle"></i> Bio updated successfully!'; document.getElementById('adminDashboard').prepend(msg); setTimeout(()=>msg.remove(),3000);
      }catch{ alert("Could not update bio."); }
    }
    async function markNumbersAsDonated(){
      if(!isAuthenticated) return;
      const input=sanitizeInput(document.getElementById('manualNumbers').value);
      if(!input){ alert('Please enter at least one number.'); return; }
      const nums=input.split(',').map(n=>parseInt(n.trim())).filter(n=>!isNaN(n)&&n>=1&&n<=80);
      if(nums.length===0){ alert('Please enter valid numbers between 1 and 80.'); return; }
      const total=nums.reduce((s,n)=>s+n,0);
      try{
        await apiDonate({ amount: total, numbers: nums, method: 'manual', donorName: 'Manual Entry (Admin)', donorPhone: 'N/A', donorAddress: 'N/A' });
        document.getElementById('manualNumbers').value='';
        const s=await apiGetState(); fundraiserData.raised=s.raised; fundraiserData.goal=s.goal; fundraiserData.bio=s.bio; fundraiserData.donations={}; s.takenNumbers.forEach(n=>fundraiserData.donations[n]=true);
        generateNumberGrid(); updateProgress(); updateAdminStats();
        const msg=document.createElement('div'); msg.className='status-indicator status-success'; msg.innerHTML=\`<i class="fas fa-check-circle"></i> Marked numbers \${nums.join(', ')} as donated!\`; document.getElementById('adminDashboard').prepend(msg); setTimeout(()=>msg.remove(),3000);
      }catch(e){ alert(e.message||"Failed to mark numbers."); }
    }
    async function downloadDonorData(){
      if(!isAuthenticated){ alert('Unlock the admin panel first.'); return; }
      try{
        const blob=await apiExportCSV(); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=\`lilia_donations_\${new Date().toISOString().slice(0,10)}.csv\`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      }catch(e){ alert(e.message||"Could not download CSV"); }
    }
    async function resetAllData(){
      if(!isAuthenticated) return;
      if(!confirm('⚠️ This will delete ALL donation data. Are you sure?')) return;
      try{
        await apiUpdateState({ bio: "I'm passionate about serving others and making a difference in the lives of children. This Tanzania mission is close to my heart!", goal: 3500 });
        alert('State reset. To fully clear donations, use your database console to truncate the "donations" table.');
      }catch{ alert('Failed to reset.'); }
    }
    document.addEventListener('keydown', function(e){ if(e.ctrlKey && e.shiftKey && e.key==='A'){ const p=document.getElementById('adminPanel'); p.style.display=p.style.display==='none'?'block':'none'; }});
    window.onload=init;
  </script>
</body>
</html>`;

app.get("/", (_req, res) => res.type("html").send(HTML));

// ---------- Error handler ----------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

await init();
app.listen(PORT, () => console.log(`✅ Running on http://localhost:${PORT}`));
