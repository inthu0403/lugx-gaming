const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const promClient = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Metrics
const register = new promClient.Registry();
const httpRequests = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'status'],
  registers: [register]
});

const pool = new Pool({
    user: process.env.DB_USER || 'lugx_user',
    host: process.env.DB_HOST || 'postgres-game',
    database: process.env.DB_NAME || 'lugx_games',
    password: process.env.DB_PASS || 'lugx_password',
    port: process.env.DB_PORT || 5432,
});

async function initDB() {
    let retries = 5;
    while (retries > 0) {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS games (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    name VARCHAR(255) NOT NULL UNIQUE,
                    category VARCHAR(100) NOT NULL,
                    price DECIMAL(10,2) NOT NULL,
                    description TEXT,
                    featured BOOLEAN DEFAULT false,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            const games = [
                ['Fortnite', 'Battle Royale', 0.00, 'Epic Battle Royale with building', true],
                ['Call of Duty: MW3', 'FPS', 69.99, 'Latest Call of Duty installment', true],
                ['Minecraft', 'Sandbox', 26.95, 'Block-building creative game', true],
                ['Cyberpunk 2077', 'RPG', 39.99, 'Futuristic open-world RPG', false],
                ['The Witcher 3', 'RPG', 19.99, 'Epic fantasy adventure', true]
            ];

            for (const game of games) {
                await pool.query(`
                    INSERT INTO games (name, category, price, description, featured)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (name) DO NOTHING
                `, game);
            }

            console.log('✅ Game Service database ready');
            break;
        } catch (error) {
            retries--;
            console.error(`DB init error (${retries} left):`, error.message);
            if (retries === 0) throw error;
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

app.use((req, res, next) => {
    res.on('finish', () => {
        httpRequests.labels(req.method, res.statusCode).inc();
    });
    next();
});

app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
});

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'healthy', service: 'game-service', timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(503).json({ status: 'unhealthy', error: error.message });
    }
});

app.get('/games', async (req, res) => {
    try {
        const { featured, category, limit = 50 } = req.query;
        let query = 'SELECT * FROM games WHERE 1=1';
        const params = [];
       
        if (featured) {
            query += ' AND featured = $' + (params.length + 1);
            params.push(featured === 'true');
        }
       
        if (category) {
            query += ' AND category ILIKE $' + (params.length + 1);
            params.push(`%${category}%`);
        }
       
        query += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
       
        const result = await pool.query(query, params);
        res.json({ games: result.rows, total: result.rows.length });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/games/featured', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM games WHERE featured = true LIMIT 10');
        res.json({ featured_games: result.rows, count: result.rows.length });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 🆕 GET individual game by ID
app.get('/games/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM games WHERE id = $1', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Game not found' });
        }
        
        res.json({ game: result.rows[0] });
    } catch (error) {
        console.error('Get game error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 🆕 POST - Create new game
app.post('/games', async (req, res) => {
    try {
        const { name, category, price, description, featured = false } = req.body;
        
        if (!name || !category || price === undefined) {
            return res.status(400).json({ error: 'name, category, and price are required' });
        }
        
        const result = await pool.query(`
            INSERT INTO games (name, category, price, description, featured)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [name, category, parseFloat(price), description, featured]);
        
        console.log(`Game created: ${name}`);
        res.status(201).json({ game: result.rows[0] });
        
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({ error: 'Game with this name already exists' });
        }
        console.error('Create game error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 🆕 PUT - Update game by ID
app.put('/games/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, category, price, description, featured } = req.body;
        
        // Check if game exists
        const existingGame = await pool.query('SELECT * FROM games WHERE id = $1', [id]);
        if (existingGame.rows.length === 0) {
            return res.status(404).json({ error: 'Game not found' });
        }
        
        // Build dynamic update query
        const updateFields = [];
        const values = [];
        let paramCount = 1;
        
        if (name !== undefined) {
            updateFields.push(`name = $${paramCount++}`);
            values.push(name);
        }
        if (category !== undefined) {
            updateFields.push(`category = $${paramCount++}`);
            values.push(category);
        }
        if (price !== undefined) {
            updateFields.push(`price = $${paramCount++}`);
            values.push(parseFloat(price));
        }
        if (description !== undefined) {
            updateFields.push(`description = $${paramCount++}`);
            values.push(description);
        }
        if (featured !== undefined) {
            updateFields.push(`featured = $${paramCount++}`);
            values.push(featured);
        }
        
        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        values.push(id);
        const query = `UPDATE games SET ${updateFields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        
        const result = await pool.query(query, values);
        
        console.log(`Game updated: ${id}`);
        res.json({ game: result.rows[0] });
        
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({ error: 'Game with this name already exists' });
        }
        console.error('Update game error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 🆕 DELETE - Delete game by ID
app.delete('/games/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query('DELETE FROM games WHERE id = $1 RETURNING *', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Game not found' });
        }
        
        console.log(`Game deleted: ${id}`);
        res.json({ message: 'Game deleted successfully', game: result.rows[0] });
        
    } catch (error) {
        console.error('Delete game error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

initDB().then(() => {
    app.listen(PORT, () => console.log(`🎯 Game Service running on port ${PORT}`));
}).catch(error => {
    console.error('Failed to start Game Service:', error);
    process.exit(1);
});
