const express = require('express');
const cors = require('cors');
const promClient = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());

// Metrics
const register = new promClient.Registry();
const analyticsEvents = new promClient.Counter({
  name: 'analytics_events_total',
  help: 'Total analytics events',
  labelNames: ['event_type'],
  registers: [register]
});

const CLICKHOUSE_HOST = process.env.CLICKHOUSE_HOST || 'http://clickhouse:8123';

async function initClickHouse() {
    let retries = 10;
    while (retries > 0) {
        try {
            await fetch(`${CLICKHOUSE_HOST}`, {
                method: 'POST',
                body: 'CREATE DATABASE IF NOT EXISTS lugx_analytics'
            });

            await fetch(`${CLICKHOUSE_HOST}`, {
                method: 'POST',
                body: `
                    CREATE TABLE IF NOT EXISTS lugx_analytics.events (
                        session_id String,
                        user_id String,
                        event_type String,
                        page_path String,
                        page_url String,
                        timestamp DateTime,
                        event_data String
                    ) ENGINE = MergeTree()
                    ORDER BY timestamp
                `
            });

            console.log('✅ ClickHouse Analytics database ready');
            break;
        } catch (error) {
            retries--;
            console.error(`ClickHouse init error (${retries} left):`, error.message);
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
        const response = await fetch(`${CLICKHOUSE_HOST}`, {
            method: 'POST',
            body: 'SELECT 1'
        });
        
        if (response.ok) {
            res.json({ status: 'healthy', service: 'analytics-service-clickhouse', timestamp: new Date().toISOString() });
        } else {
            throw new Error('ClickHouse not responding');
        }
    } catch (error) {
        res.status(503).json({ status: 'unhealthy', error: error.message });
    }
});

app.post('/analytics', async (req, res) => {
    try {
        const { session_id, user_id, event_type, page_path, page_url, data } = req.body;
        
        if (!session_id || !user_id || !event_type || !page_path) {
            return res.status(400).json({ error: 'Missing required fields: session_id, user_id, event_type, page_path' });
        }

        // Properly escape strings for ClickHouse
        const escapedSessionId = session_id.replace(/'/g, "''").substring(0, 100);
        const escapedUserId = user_id.replace(/'/g, "''").substring(0, 100);
        const escapedEventType = event_type.replace(/'/g, "''").substring(0, 100);
        const escapedPagePath = page_path.replace(/'/g, "''").substring(0, 200);
        const escapedPageUrl = (page_url || page_path).replace(/'/g, "''").substring(0, 500);
        const escapedEventData = JSON.stringify(data || {}).replace(/'/g, "''");
        
        // Format timestamp for ClickHouse (NO milliseconds)
        const now = new Date();
        const timestamp = now.getFullYear() + '-' + 
                         String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                         String(now.getDate()).padStart(2, '0') + ' ' + 
                         String(now.getHours()).padStart(2, '0') + ':' + 
                         String(now.getMinutes()).padStart(2, '0') + ':' + 
                         String(now.getSeconds()).padStart(2, '0');

        const insertQuery = `INSERT INTO lugx_analytics.events (session_id, user_id, event_type, page_path, page_url, timestamp, event_data) VALUES ('${escapedSessionId}', '${escapedUserId}', '${escapedEventType}', '${escapedPagePath}', '${escapedPageUrl}', '${timestamp}', '${escapedEventData}')`;

        console.log(`📊 Inserting analytics event: ${event_type} for user ${user_id}`);

        const response = await fetch(`${CLICKHOUSE_HOST}`, {
            method: 'POST',
            body: insertQuery
        });

        const responseText = await response.text();
        
        if (response.ok && responseText.trim() === '') {
            analyticsEvents.labels(event_type).inc();
            console.log(`✅ Analytics: ${event_type} stored successfully in ClickHouse`);
            res.json({ success: true, message: 'Event stored in ClickHouse' });
        } else {
            console.error('ClickHouse insert failed:', response.status, responseText);
            throw new Error(`ClickHouse insert failed: ${responseText}`);
        }
        
    } catch (error) {
        console.error('Analytics error:', error.message);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// 🆕 GET analytics data by filters
app.get('/analytics', async (req, res) => {
    try {
        const { 
            user_id, 
            session_id, 
            event_type, 
            page_path, 
            start_date, 
            end_date, 
            limit = 100 
        } = req.query;
        
        let whereClause = 'WHERE 1=1';
        
        if (user_id) {
            whereClause += ` AND user_id = '${user_id.replace(/'/g, "''")}'`;
        }
        if (session_id) {
            whereClause += ` AND session_id = '${session_id.replace(/'/g, "''")}'`;
        }
        if (event_type) {
            whereClause += ` AND event_type = '${event_type.replace(/'/g, "''")}'`;
        }
        if (page_path) {
            whereClause += ` AND page_path LIKE '%${page_path.replace(/'/g, "''")}%'`;
        }
        if (start_date) {
            whereClause += ` AND timestamp >= '${start_date}'`;
        }
        if (end_date) {
            whereClause += ` AND timestamp <= '${end_date}'`;
        }
        
        const query = `SELECT * FROM lugx_analytics.events ${whereClause} ORDER BY timestamp DESC LIMIT ${parseInt(limit)} FORMAT JSON`;
        
        const response = await fetch(`${CLICKHOUSE_HOST}`, {
            method: 'POST',
            body: query
        });
        
        if (response.ok) {
            const result = await response.json();
            res.json({
                events: result.data || [],
                total: result.data ? result.data.length : 0,
                filters: req.query
            });
        } else {
            const errorText = await response.text();
            throw new Error(`ClickHouse query failed: ${errorText}`);
        }
        
    } catch (error) {
        console.error('Get analytics error:', error.message);
        res.status(500).json({ error: 'Failed to get analytics data', details: error.message });
    }
});

// 🆕 DELETE analytics data by filters (GDPR compliance)
app.delete('/analytics', async (req, res) => {
    try {
        const { user_id, session_id, before_date } = req.body;
        
        if (!user_id && !session_id && !before_date) {
            return res.status(400).json({ 
                error: 'At least one filter required: user_id, session_id, or before_date' 
            });
        }
        
        let whereClause = 'WHERE 1=1';
        
        if (user_id) {
            whereClause += ` AND user_id = '${user_id.replace(/'/g, "''")}'`;
        }
        if (session_id) {
            whereClause += ` AND session_id = '${session_id.replace(/'/g, "''")}'`;
        }
        if (before_date) {
            whereClause += ` AND timestamp < '${before_date}'`;
        }
        
        // First count what will be deleted
        const countQuery = `SELECT count() as total FROM lugx_analytics.events ${whereClause} FORMAT JSON`;
        const countResponse = await fetch(`${CLICKHOUSE_HOST}`, {
            method: 'POST',
            body: countQuery
        });
        
        if (!countResponse.ok) {
            throw new Error('Failed to count records for deletion');
        }
        
        const countResult = await countResponse.json();
        const recordsToDelete = countResult.data[0].total;
        
        if (recordsToDelete === 0) {
            return res.json({ message: 'No records found matching the criteria', deleted_count: 0 });
        }
        
        // Perform the deletion
        const deleteQuery = `ALTER TABLE lugx_analytics.events DELETE ${whereClause}`;
        const deleteResponse = await fetch(`${CLICKHOUSE_HOST}`, {
            method: 'POST',
            body: deleteQuery
        });
        
        if (deleteResponse.ok) {
            console.log(`Analytics data deleted: ${recordsToDelete} records`);
            res.json({ 
                message: 'Analytics data deleted successfully', 
                deleted_count: recordsToDelete,
                filters: req.body
            });
        } else {
            const errorText = await deleteResponse.text();
            throw new Error(`ClickHouse delete failed: ${errorText}`);
        }
        
    } catch (error) {
        console.error('Delete analytics error:', error.message);
        res.status(500).json({ error: 'Failed to delete analytics data', details: error.message });
    }
});

app.get('/analytics/dashboard', async (req, res) => {
    try {
        const query = `SELECT count() as total_events, uniq(user_id) as unique_users, uniq(session_id) as unique_sessions, countIf(event_type = 'page_view') as page_views, countIf(event_type = 'click_event') as clicks FROM lugx_analytics.events WHERE timestamp >= today() FORMAT JSON`;
        
        const response = await fetch(`${CLICKHOUSE_HOST}`, {
            method: 'POST',
            body: query
        });
        
        if (response.ok) {
            const result = await response.json();
            res.json({
                overview: result.data[0] || {},
                date: new Date().toISOString().split('T')[0],
                timestamp: new Date().toISOString()
            });
        } else {
            const errorText = await response.text();
            throw new Error(`ClickHouse query failed: ${errorText}`);
        }
        
    } catch (error) {
        console.error('Dashboard query error:', error.message);
        res.status(500).json({ error: 'Failed to generate dashboard data', details: error.message });
    }
});

console.log('✅ Fixed Analytics Service starting...');
initClickHouse().then(() => {
    app.listen(PORT, () => console.log(`📊 Fixed Analytics Service with ClickHouse running on port ${PORT}`));
}).catch(error => {
    console.error('Failed to start Analytics Service:', error);
    process.exit(1);
});
