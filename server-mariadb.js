const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mysql = require('mysql2/promise');
const sanitizeHtml = require('sanitize-html');

let onlineCount = 0;

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

async function initializeDB() {
  let conn;
  try {
    conn = await pool.getConnection();
    
    await conn.query('CREATE DATABASE IF NOT EXISTS chat_db');
    await conn.query('USE chat_db');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
  } catch (err) {
    console.error('Ошибка инициализации БД:', err);
  } finally {
    if (conn) conn.release();
  }
}

app.use(express.static('public'));
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', 
    "default-src 'self';" +
    "script-src 'self' 'unsafe-inline' cdn.socket.io;" +
    "style-src 'self' 'unsafe-inline';" +
    "img-src 'self' data:;");
  next();
});

io.on('connection', async (socket) => {
  onlineCount++;
  updateOnlineCount();

  try {
    const [rows] = await pool.query(
      'SELECT username, message, UNIX_TIMESTAMP(created_at) * 1000 AS timestamp FROM messages ORDER BY created_at DESC LIMIT 50'
    );
    socket.emit('history', rows.reverse());
  } catch (err) {
    console.error('Ошибка загрузки истории:', err);
  }

  socket.on('message', async (data) => {
    try {
      if (!data.username || !data.message) return;
      
      let username = data.username.toString().substring(0, 255);
      username = sanitizeHtml(username, {
        ...sanitizeOptions,
        allowedTags: ['b', 'i', 'em', 'strong']
      });
      username = cleanZalgo(username);
      
      let message = data.message.toString().substring(0, 1000);
      message = sanitizeHtml(message, sanitizeOptions);
      message = cleanZalgo(message);
      
      if (!username.trim() || !message.trim()) {
        return socket.emit('errorMessage', 'Сообщение содержит только недопустимые символы');
      }
  
      await pool.query(
        'INSERT INTO messages (username, message) VALUES (?, ?)',
        [username, message]
      );
  
      io.emit('message', {
        username: username,
        message: message,
        timestamp: Date.now()
      });
      
    } catch (err) {
      console.error('Ошибка сохранения:', err);
      socket.emit('errorMessage', 'Ошибка при отправке сообщения');
    }
  });

  socket.on('disconnect', () => {
    onlineCount--;
    updateOnlineCount();
  });
});

function updateOnlineCount() {
  io.emit('online', onlineCount);
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
  http.listen(3000, () => {
    console.log('Сервер запущен');
  });
});