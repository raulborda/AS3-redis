

require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const connectDB = require('./config/db');

const app = express();

// Conf de Redis -> Corriendo en mi MV Linux
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

let db;
let productsCollection;

// Medir tiempo ... con este middleware, podemos comparar cache contra mongo directo
const timeMiddleware = (req, res, next) => {
  req.startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    console.log(`${req.path} - Tiempo: ${duration}ms`);
  });
  next();
};

//Aqui le decimos a express que use el middleware
app.use(timeMiddleware);
app.use(express.json());


// GET de todos los productos sin caché
app.get('/products', async (req, res) => {
  try {
    const products = await productsCollection.find({}).toArray();
    res.json(products);
  } catch (error) {
    console.error('Error en /products:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET de todos los productos con caché
app.get('/products-cached', async (req, res) => {
  try {
    const cachedProducts = await redis.get('products');
    
    if (cachedProducts) {
      console.log('Datos desde Redis cache');
      return res.json(JSON.parse(cachedProducts));
    }

    console.log('Cache miss - Consultando MongoDB');
    const products = await productsCollection.find({}).toArray();
    
    await redis.set('products', JSON.stringify(products), 'EX', 3600);
    
    res.json(products);
  } catch (error) {
    console.error('Error en /products-cached:', error);
    res.status(500).json({ error: error.message });
  }
});



// GET de  un solo producto por ID
app.get('/products/:id', async (req, res) => {
  try {
    const product = await productsCollection.findOne({ _id: req.params.id });
    if (!product) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    res.json(product);
  } catch (error) {
    console.error('Error en /products/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

// Crear un  producto
app.post('/products', async (req, res) => {
  try {
    const result = await productsCollection.insertOne(req.body);
    await redis.del('products'); // Invalidar caché
    res.status(201).json(result);
  } catch (error) {
    console.error('Error al crear producto:', error);
    res.status(500).json({ error: error.message });
  }
});

// Actualizar un producto
app.put('/products/:id', async (req, res) => {
  try {
    const result = await productsCollection.updateOne(
      { _id: req.params.id },
      { $set: req.body }
    );
    await redis.del('products'); // Invalidar caché
    res.json(result);
  } catch (error) {
    console.error('Error al actualizar producto:', error);
    res.status(500).json({ error: error.message });
  }
});

// Eliminar un producto
app.delete('/products/:id', async (req, res) => {
  try {
    const result = await productsCollection.deleteOne({ _id: req.params.id });
    await redis.del('products'); // Invalidar caché
    res.json(result);
  } catch (error) {
    console.error('Error al eliminar producto:', error);
    res.status(500).json({ error: error.message });
  }
});

// Búsqueda de productos
app.get('/products/search/:query', async (req, res) => {
  try {
    const query = req.params.query;
    const products = await productsCollection.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { description: { $regex: query, $options: 'i' } }
      ]
    }).toArray();
    
    res.json(products);
  } catch (error) {
    console.error('Error en búsqueda:', error);
    res.status(500).json({ error: error.message });
  }
});

// Estadísticas de productos
app.get('/stats', async (req, res) => {
  try {
    const stats = await productsCollection.aggregate([
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          avgPrice: { $avg: '$price' },
          minPrice: { $min: '$price' },
          maxPrice: { $max: '$price' },
          categoryCounts: { 
            $push: {
              category: '$category',
              count: 1
            }
          }
        }
      }
    ]).toArray();
    
    res.json(stats[0]);
  } catch (error) {
    console.error('Error en estadísticas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Llenar la base de datos con datos de prueba... esto es un populate 🙄 ...
app.post('/populate', async (req, res) => {
  try {
    const testProducts = Array.from({ length: 1000 }, (_, i) => ({
      name: `Product ${i}`,
      description: `Description for product ${i}`,
      price: Math.random() * 1000,
      category: ['Electronics', 'Books', 'Clothing', 'Food'][Math.floor(Math.random() * 4)],
      inStock: Math.random() > 0.5,
      createdAt: new Date()
    }));
    
    const result = await productsCollection.insertMany(testProducts);
    await redis.del('products'); // Invalidar caché
    res.json({ 
      message: 'Database populated successfully',
      insertedCount: result.insertedCount 
    });
  } catch (error) {
    console.error('Error en /populate:', error);
    res.status(500).json({ error: error.message });
  }
});

// Limpiar la caché de Redis.... 
app.post('/clear-cache', async (req, res) => {
  try {
    await redis.del('products');
    res.json({ message: 'Cache cleared successfully' });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar el estado de todas las conexiones... tanto a mongo como a redis
app.get('/health', async (req, res) => {
  try {
    const mongoStatus = await db.command({ ping: 1 });
    const redisStatus = await redis.ping();
    
    res.json({
      mongodb: mongoStatus.ok === 1 ? 'connected' : 'disconnected',
      redis: redisStatus === 'PONG' ? 'connected' : 'disconnected',
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      mongodb: 'error',
      redis: 'error'
    });
  }
});


// Inicializar la aplicación
const initializeApp = async () => {
  try {
    // Conectar a MongoDB primero
    db = await connectDB();
    
    // Inicializar la colección después de conectar a la BD
    productsCollection = db.collection('products');
    
    // Crear índices para mejor rendimiento en las búsquedas o queryssss
    await productsCollection.createIndex({ name: 1 });
    await productsCollection.createIndex({ price: 1 });
    await productsCollection.createIndex({ category: 1 });
    
    // Server init...
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`
        =================================
        🚀 Servidor iniciado
        ---------------------------------
        📡 Puerto: ${PORT}
        💾 MongoDB: conectado
        📦 Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}
        ⏱️ Cache TTL: 3600 segundos
        =================================
      `);
    });
  } catch (error) {
    console.error('Failed to initialize application:', error);
    process.exit(1);
  }
};

// Manejo de cierre graceful
process.on('SIGINT', async () => {
  console.log('\nCerrando conexiones...');
  try {
    await redis.quit();
    await db.client.close();
    console.log('Conexiones cerradas correctamente');
    process.exit(0);
  } catch (error) {
    console.error('Error al cerrar conexiones:', error);
    process.exit(1);
  }
});


initializeApp();