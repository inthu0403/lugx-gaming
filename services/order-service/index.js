const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const promClient = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// Metrics
const register = new promClient.Registry();
const ordersTotal = new promClient.Counter({
  name: 'orders_total',
  help: 'Total orders created',
  registers: [register]
});

const pool = new Pool({
    user: process.env.DB_USER || 'lugx_user',
    host: process.env.DB_HOST || 'postgres-order',
    database: process.env.DB_NAME || 'lugx_orders',
    password: process.env.DB_PASS || 'lugx_password',
    port: process.env.DB_PORT || 5432,
});

async function initDB() {
    let retries = 5;
    while (retries > 0) {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS orders (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    order_number VARCHAR(50) UNIQUE NOT NULL,
                    user_id VARCHAR(255) NOT NULL,
                    status VARCHAR(50) DEFAULT 'pending',
                    total_amount DECIMAL(10,2) DEFAULT 0.00,
                    customer_email VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await pool.query(`
                CREATE TABLE IF NOT EXISTS order_items (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
                    game_id UUID,
                    product_title VARCHAR(255) NOT NULL,
                    product_price DECIMAL(10,2) NOT NULL,
                    quantity INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            console.log('✅ Order Service database ready');
            break;
        } catch (error) {
            retries--;
            console.error(`Order DB init error (${retries} left):`, error.message);
            if (retries === 0) throw error;
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
});

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'healthy', service: 'order-service', timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(503).json({ status: 'unhealthy', error: error.message });
    }
});

app.get('/orders', async (req, res) => {
    try {
        const { user_id, limit = 50 } = req.query;
        let query = 'SELECT * FROM orders WHERE 1=1';
        const params = [];
       
        if (user_id) {
            query += ' AND user_id = $' + (params.length + 1);
            params.push(user_id);
        }
       
        query += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
       
        const result = await pool.query(query, params);
        res.json({ orders: result.rows, total: result.rows.length });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 🆕 GET individual order by ID
app.get('/orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get order details
        const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        // Get order items
        const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
        
        const order = orderResult.rows[0];
        order.items = itemsResult.rows;
        
        res.json({ order });
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/orders', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
       
        const { user_id, items, customer_email } = req.body;
        if (!user_id || !items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'user_id and items required' });
        }
       
        const total = items.reduce((sum, item) => sum + (parseFloat(item.product_price) || 0), 0);
        const orderNum = 'LUGX-' + Date.now();
       
        const orderResult = await client.query(`
            INSERT INTO orders (order_number, user_id, total_amount, customer_email)
            VALUES ($1, $2, $3, $4) RETURNING *
        `, [orderNum, user_id, total, customer_email]);
       
        const order = orderResult.rows[0];
       
        for (const item of items) {
            await client.query(`
                INSERT INTO order_items (order_id, game_id, product_title, product_price, quantity)
                VALUES ($1, $2, $3, $4, $5)
            `, [order.id, item.game_id, item.product_title, item.product_price, item.quantity || 1]);
        }
       
        await client.query('COMMIT');
        ordersTotal.inc();
        
        console.log(`Order created: ${orderNum}`);
        res.status(201).json(order);
       
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Order creation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// 🆕 PUT - Update order status
app.put('/orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, customer_email } = req.body;
        
        // Check if order exists
        const existingOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
        if (existingOrder.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        // Build dynamic update query
        const updateFields = [];
        const values = [];
        let paramCount = 1;
        
        if (status !== undefined) {
            const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({ error: 'Invalid status', validStatuses });
            }
            updateFields.push(`status = $${paramCount++}`);
            values.push(status);
        }
        
        if (customer_email !== undefined) {
            updateFields.push(`customer_email = $${paramCount++}`);
            values.push(customer_email);
        }
        
        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        values.push(id);
        const query = `UPDATE orders SET ${updateFields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        
        const result = await pool.query(query, values);
        
        console.log(`Order updated: ${id} - Status: ${status}`);
        res.json({ order: result.rows[0] });
        
    } catch (error) {
        console.error('Update order error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 🆕 DELETE - Delete order by ID (with cascade to items)
app.delete('/orders/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const { id } = req.params;
        
        // Check if order exists
        const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        // Delete order (order_items will be cascade deleted due to foreign key)
        await client.query('DELETE FROM orders WHERE id = $1', [id]);
        
        await client.query('COMMIT');
        
        console.log(`Order deleted: ${id}`);
        res.json({ message: 'Order deleted successfully', order: orderResult.rows[0] });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete order error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

initDB().then(() => {
    app.listen(PORT, () => console.log(`🛒 Order Service running on port ${PORT}`));
}).catch(error => {
    console.error('Failed to start Order Service:', error);
    process.exit(1);
});
