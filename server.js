const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mysql = require('mysql2/promise');
const sanitizeHtml = require('sanitize-html');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const session = require('express-session');

let onlineCount = 0;
let onlineUsers = {};
const onlineUserIds = new Set();
const JWT_SECRET = 'your_jwt_secret_key';

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'bruh_password',
  database: 'chat_db',
  port: 3306
});

const sanitizeOptions = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: 'discard'
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Недопустимый формат файла'), false);
    }
  }
});

async function initializeDB() {
  let conn;
  try {
    conn = await pool.getConnection();
    
    await conn.query('CREATE DATABASE IF NOT EXISTS chat_db');
    await conn.query('USE chat_db');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        avatar VARCHAR(255) DEFAULT 'default-avatar.jpg',
        description TEXT DEFAULT '',
        role ENUM('user','moderator','developer') DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
  } catch (err) {
    console.error('Ошибка инициализации БД:', err);
  } finally {
    if (conn) conn.release();
  }
}

app.use(express.static('public', { index: false }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: JWT_SECRET,
  resave: false,
  saveUninitialized: true
}));
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', 
    "default-src 'self';" +
    "script-src 'self' 'unsafe-inline' cdn.socket.io;" +
    "style-src 'self' 'unsafe-inline';" +
    "img-src 'self' data: blob: http: https:;" +
    "connect-src 'self' ws: wss:;");
  next();
});

function checkAuth(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.redirect('/login.html');
  }
}

app.get('/', checkAuth, (req, res) => {
  res.sendFile(__dirname + '/private/index.html');
});

app.get('/login.html', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

app.get('/register.html', (req, res) => {
  res.sendFile(__dirname + '/public/register.html');
});

app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);

    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'Имя пользователя занято' });
    } else {
      res.status(500).json({ error: 'Ошибка регистрации' });
    }
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (!rows.length) return res.status(400).json({ error: 'Неверные данные' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Неверные данные' });

    req.session.userId = user.id;
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка логина' });
  }
});

app.get('/profile/:id', checkAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, avatar, description, role FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).send('Пользователь не найден');

    res.sendFile(__dirname + '/private/profile.html');
  } catch (err) {
    res.status(500).send('Ошибка');
  }
});

app.get('/api/profile/:id', checkAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, username, avatar, description, role FROM users WHERE id = ?', 
      [req.params.id]
    );
    
    if (!rows[0]) return res.json({});
    
    const profile = rows[0];
    profile.avatar = formatAvatarPath(profile.avatar);
    
    profile.online = onlineUserIds.has(parseInt(req.params.id));
    
    res.json(profile);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/update-profile', checkAuth, (req, res, next) => {
  upload.single('avatar')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      console.error('Multer error:', err);
      return res.status(400).json({ error: `Ошибка загрузки файла: ${err.message}` });
    } else if (err) {
      console.error('Unknown upload error:', err);
      return res.status(500).json({ error: `Ошибка загрузки: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { username, description } = req.body;
    let avatarPath = null;

    if (req.file) {
      avatarPath = 'uploads/' + req.file.filename;
      const [rows] = await pool.query('SELECT avatar FROM users WHERE id = ?', [userId]);
      const oldAvatar = rows[0].avatar;
      if (oldAvatar && oldAvatar !== 'default-avatar.jpg') {
        const oldPath = path.join(__dirname, 'public', oldAvatar);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        } else {
          console.warn(`Старый аватар не найден: ${oldPath}`);
        }
      }
    }

    let query = 'UPDATE users SET ';
    let params = [];
    if (username) {
      query += 'username = ?, ';
      params.push(username);
    }
    if (description) {
      query += 'description = ?, ';
      params.push(description.substring(0, 500));
    }
    if (avatarPath) {
      query += 'avatar = ?, ';
      params.push(avatarPath);
    }
    if (query.endsWith('SET ')) {
      return res.json({ success: true });
    }
    query = query.slice(0, -2) + ' WHERE id = ?';
    params.push(userId);

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка обновления профиля:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'Имя пользователя занято' });
    } else {
      res.status(500).json({ error: 'Ошибка обновления: ' + err.message });
    }
  }
});

app.get('/api/me', checkAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM users WHERE id = ?', [req.session.userId]);
    if (!rows[0]) return res.status(404).json({});
    res.json({ id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function formatAvatarPath(avatar) {
  if (!avatar || avatar === 'default-avatar.jpg') {
    return '/uploads/default-avatar.jpg';
  }
  return avatar.startsWith('/') ? avatar : '/' + avatar;
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Аутентификация требуется'));

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Неверный токен'));
    socket.userId = decoded.userId;
    next();
  });
});

io.on('connection', async (socket) => {
  onlineCount++;

  try {
    const [userRows] = await pool.query('SELECT id, username, avatar, role FROM users WHERE id = ?', [socket.userId]);
    const user = userRows[0];
    if (user) {
      user.avatar = formatAvatarPath(user.avatar);
      onlineUsers[socket.id] = user;
      onlineUserIds.add(user.id);
    }
    updateOnlineData();
  } catch (err) {
    console.error('Ошибка загрузки данных пользователя:', err);
  }

  try {
    const [rows] = await pool.query(
      `SELECT u.id as userId, u.username, u.avatar,  u.role, m.message, UNIX_TIMESTAMP(m.created_at) * 1000 AS timestamp
       FROM messages m
       JOIN users u ON m.user_id = u.id
       ORDER BY m.created_at DESC LIMIT 50`
    );

    const history = rows.reverse().map(r => ({
      id: r.userId,
      username: r.username,
      avatar: formatAvatarPath(r.avatar),
      role: r.role,
      message: r.message,
      timestamp: r.timestamp
    }));

    socket.emit('history', history);
  } catch (err) {
    console.error('Ошибка загрузки истории:', err);
  }

  socket.on('message', async (data) => {
    try {
      if (!data.message) return;

      let message = data.message.toString().substring(0, 1000);
      message = sanitizeHtml(message, sanitizeOptions);
      message = cleanZalgo(message);

      if (!message.trim()) {
        return socket.emit('errorMessage', 'Сообщение содержит только недопустимые символы');
      }

      await pool.query('INSERT INTO messages (user_id, message) VALUES (?, ?)', [socket.userId, message]);

      const [uRows] = await pool.query('SELECT id, username, avatar, role FROM users WHERE id = ?', [socket.userId]);
      const u = uRows[0];
      const outgoing = {
        id: u.id,
        username: u.username,
        avatar: formatAvatarPath(u.avatar),
        role: u.role,
        message,
        timestamp: Date.now()
      };

      io.emit('message', outgoing);

    } catch (err) {
      console.error('Ошибка сохранения:', err);
      socket.emit('errorMessage', 'Ошибка при отправке сообщения');
    }
  });

  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (user) {
      delete onlineUsers[socket.id];
      onlineUserIds.delete(user.id);
    }
    onlineCount--;
    updateOnlineData();
  });
});


function updateOnlineData() {
  const users = Object.values(onlineUsers).map(user => ({
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    role: user.role,
    online: true
  }));
  
  io.emit('onlineData', {
    count: users.length,
    users: users
  });
}

function cleanZalgo(text) {
  return text
  .normalize('NFKD')              
  .replace(/[\u0300-\u036F]/g, '')
  .replace(/[\u1AB0-\u1AFF]/g, '')
  .replace(/[\u1DC0-\u1DFF]/g, '')
  .replace(/[\u20D0-\u20FF]/g, '')
  .replace(/[\uFE20-\uFE2F]/g, '')
  .replace(/\s+/g, ' ')           
  .trim();
}

initializeDB().then(() => {
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  const defaultAvatarPath = path.join(uploadsDir, 'default-avatar.jpg');
  if (!fs.existsSync(defaultAvatarPath)) {
    fs.writeFileSync(defaultAvatarPath, '');
  }
  http.listen(3000, () => {
    console.log('Сервер запущен');
  });
});