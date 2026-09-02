require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');

const app = express();

// ============================================================
// BANCO DE DADOS
// ============================================================
const db = new sqlite3.Database('./database.db');

// Helpers para usar Promises com sqlite3
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Inicializa tabelas
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS event_config (
      id INTEGER PRIMARY KEY,
      nome TEXT NOT NULL,
      data TEXT,
      local TEXT,
      preco REAL NOT NULL DEFAULT 0,
      admin_password TEXT NOT NULL DEFAULT 'admin123',
      banner_url TEXT DEFAULT ''
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS guests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      cpf TEXT NOT NULL,
      rg TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'pending',
      mp_preference_id TEXT,
      mp_payment_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME,
      entered_at DATETIME
    )
  `);
  // Config inicial do evento (se não existir)
  db.get('SELECT id FROM event_config WHERE id = 1', [], (err, row) => {
    if (!row) {
      db.run(
        `INSERT INTO event_config (id, nome, data, local, preco, admin_password)
         VALUES (1, ?, ?, ?, ?, ?)`,
        [
          process.env.EVENT_NAME || 'Meu Evento',
          process.env.EVENT_DATE || '2024-12-31',
          process.env.EVENT_LOCATION || 'Local do Evento',
          parseFloat(process.env.EVENT_PRICE || '50'),
          process.env.ADMIN_PASSWORD || 'admin123',
        ]
      );
    }
  });
});

// ============================================================
// MERCADO PAGO
// ============================================================
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || 'TEST-0000',
});

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// HELPERS
// ============================================================
function formatCPF(cpf) {
  return (cpf || '').replace(/\D/g, '');
}

async function getEvent() {
  return dbGet('SELECT * FROM event_config WHERE id = 1');
}

// ============================================================
// ROTAS DA API
// ============================================================

// --- INFO DO EVENTO (pública) ---
app.get('/api/event', async (req, res) => {
  const event = await getEvent();
  res.json({
    nome: event.nome,
    data: event.data,
    local: event.local,
    preco: event.preco,
    banner_url: event.banner_url,
  });
});

// --- INSCRIÇÃO DO CONVIDADO ---
app.post('/api/register', async (req, res) => {
  try {
    const { nome, cpf, rg } = req.body;

    if (!nome || !cpf || !rg) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    const cpfClean = formatCPF(cpf);
    const existing = await dbGet('SELECT * FROM guests WHERE cpf = ?', [cpfClean]);

    if (existing && (existing.status === 'paid' || existing.status === 'entered')) {
      return res.json({
        already_registered: true,
        ticket_url: `/ticket.html?token=${existing.token}`,
      });
    }

    const event = await getEvent();
    const token = crypto.randomUUID();
    const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

    // Cria preferência no Mercado Pago
    const preference = new Preference(mpClient);
    const prefResult = await preference.create({
      body: {
        items: [
          {
            id: 'ingresso-01',
            title: `Ingresso — ${event.nome}`,
            quantity: 1,
            unit_price: parseFloat(event.preco),
            currency_id: 'BRL',
          },
        ],
        payer: { name: nome.trim() },
        external_reference: token,
        back_urls: {
          success: `${baseUrl}/ticket.html?token=${token}`,
          failure: `${baseUrl}/?erro=pagamento_cancelado`,
          pending: `${baseUrl}/ticket.html?token=${token}`,
        },
        auto_return: 'approved',
        notification_url: `${baseUrl}/api/webhook`,
        statement_descriptor: event.nome.substring(0, 22),
      },
    });

    if (existing) {
      await dbRun(
        `UPDATE guests SET nome = ?, rg = ?, token = ?, mp_preference_id = ?, status = 'pending' WHERE cpf = ?`,
        [nome.trim(), rg.trim(), token, prefResult.id, cpfClean]
      );
    } else {
      await dbRun(
        `INSERT INTO guests (nome, cpf, rg, token, mp_preference_id) VALUES (?, ?, ?, ?, ?)`,
        [nome.trim(), cpfClean, rg.trim(), token, prefResult.id]
      );
    }

    res.json({
      payment_url: prefResult.init_point,
      sandbox_url: prefResult.sandbox_init_point,
    });
  } catch (err) {
    console.error('Erro no registro:', err?.message || err);
    res.status(500).json({ error: 'Erro ao processar inscrição. Tente novamente.' });
  }
});

// --- WEBHOOK MERCADO PAGO ---
app.post('/api/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment' && data?.id) {
      const payment = new Payment(mpClient);
      const paymentData = await payment.get({ id: data.id });
      console.log(`[Webhook] Pagamento ${data.id} — status: ${paymentData.status}`);

      if (paymentData.status === 'approved') {
        const token = paymentData.external_reference;
        await dbRun(
          `UPDATE guests SET status = 'paid', mp_payment_id = ?, paid_at = CURRENT_TIMESTAMP
           WHERE token = ? AND status = 'pending'`,
          [String(data.id), token]
        );
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook:', err?.message || err);
    res.sendStatus(200);
  }
});

// --- DADOS DO BILHETE ---
app.get('/api/ticket/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const guest = await dbGet('SELECT * FROM guests WHERE token = ?', [token]);
    if (!guest) return res.status(404).json({ error: 'Bilhete não encontrado.' });

    const event = await getEvent();
    const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const qrPayload = `${baseUrl}/portaria.html#${token}`;
    const qrCode = await QRCode.toDataURL(qrPayload, {
      width: 280,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
      errorCorrectionLevel: 'H',
    });

    res.json({
      guest: {
        nome: guest.nome,
        cpf: guest.cpf,
        rg: guest.rg,
        status: guest.status,
        paid_at: guest.paid_at,
        entered_at: guest.entered_at,
      },
      event: { nome: event.nome, data: event.data, local: event.local },
      qrCode,
      token: guest.token,
    });
  } catch (err) {
    console.error('Erro ao buscar bilhete:', err?.message || err);
    res.status(500).json({ error: 'Erro ao carregar bilhete.' });
  }
});

// --- VALIDAÇÃO NA PORTARIA ---
app.post('/api/validate', async (req, res) => {
  try {
    const { token, portaria_password } = req.body;
    const event = await getEvent();

    if (portaria_password !== event.admin_password) {
      return res.status(401).json({ valid: false, message: 'Senha da portaria incorreta.' });
    }
    if (!token) {
      return res.status(400).json({ valid: false, message: 'Token não informado.' });
    }

    const guest = await dbGet('SELECT * FROM guests WHERE token = ?', [token]);
    if (!guest) {
      return res.json({ valid: false, type: 'not_found', message: 'Bilhete não encontrado.' });
    }
    if (guest.status === 'entered') {
      return res.json({
        valid: false,
        type: 'already_entered',
        message: 'Este bilhete já foi utilizado!',
        guest: { nome: guest.nome, entered_at: guest.entered_at },
      });
    }
    if (guest.status === 'pending') {
      return res.json({
        valid: false,
        type: 'not_paid',
        message: 'Pagamento não confirmado.',
        guest: { nome: guest.nome },
      });
    }

    await dbRun(
      `UPDATE guests SET status = 'entered', entered_at = CURRENT_TIMESTAMP WHERE token = ?`,
      [token]
    );

    return res.json({
      valid: true,
      type: 'ok',
      message: 'Entrada autorizada!',
      guest: { nome: guest.nome, cpf: guest.cpf },
      event: { nome: event.nome },
    });
  } catch (err) {
    console.error('Erro na validação:', err?.message || err);
    res.status(500).json({ valid: false, message: 'Erro interno.' });
  }
});

// ============================================================
// ROTAS ADMIN
// ============================================================
async function checkAdminAuth(req, res) {
  const event = await getEvent();
  const pwd = req.headers['x-admin-password'] || req.query.password;
  if (pwd !== event.admin_password) {
    res.status(401).json({ error: 'Senha incorreta.' });
    return false;
  }
  return true;
}

// Lista todos os convidados
app.get('/api/admin/guests', async (req, res) => {
  if (!(await checkAdminAuth(req, res))) return;

  const guests = await dbAll(
    `SELECT id, nome, cpf, rg, status, created_at, paid_at, entered_at
     FROM guests ORDER BY created_at DESC`
  );
  const stats = {
    total: guests.length,
    pending: guests.filter((g) => g.status === 'pending').length,
    paid: guests.filter((g) => g.status === 'paid').length,
    entered: guests.filter((g) => g.status === 'entered').length,
  };

  res.json({ guests, stats, event: await getEvent() });
});

// Atualiza evento
app.put('/api/admin/event', async (req, res) => {
  if (!(await checkAdminAuth(req, res))) return;
  const { nome, data, local, preco, banner_url, admin_password } = req.body;

  if (admin_password) {
    await dbRun(
      `UPDATE event_config SET nome=?, data=?, local=?, preco=?, banner_url=?, admin_password=? WHERE id=1`,
      [nome, data, local, preco, banner_url || '', admin_password]
    );
  } else {
    await dbRun(
      `UPDATE event_config SET nome=?, data=?, local=?, preco=?, banner_url=? WHERE id=1`,
      [nome, data, local, preco, banner_url || '']
    );
  }
  res.json({ success: true });
});

// Exporta CSV
app.get('/api/admin/export', async (req, res) => {
  if (!(await checkAdminAuth(req, res))) return;

  const guests = await dbAll(
    'SELECT nome, cpf, rg, status, created_at, paid_at, entered_at FROM guests ORDER BY nome'
  );
  const statusLabel = { pending: 'Pendente', paid: 'Pago', entered: 'Entrou' };
  const csv = [
    'Nome,CPF,RG,Status,Inscrito em,Pago em,Entrou em',
    ...guests.map((g) =>
      [g.nome, g.cpf, g.rg, statusLabel[g.status] || g.status, g.created_at, g.paid_at || '', g.entered_at || ''].join(',')
    ),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="convidados.csv"');
  res.send('﻿' + csv);
});

// Remove convidado
app.delete('/api/admin/guests/:id', async (req, res) => {
  if (!(await checkAdminAuth(req, res))) return;
  await dbRun('DELETE FROM guests WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Confirma pagamento manualmente
app.post('/api/admin/guests/:id/confirm', async (req, res) => {
  if (!(await checkAdminAuth(req, res))) return;
  await dbRun(
    `UPDATE guests SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`,
    [req.params.id]
  );
  res.json({ success: true });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎉 Servidor rodando em http://localhost:${PORT}`);
  console.log(`   Painel Admin : http://localhost:${PORT}/admin.html`);
  console.log(`   Portaria     : http://localhost:${PORT}/portaria.html\n`);
});
