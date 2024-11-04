const { MongoClient } = require('mongodb');

if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is not defined in environment variables');
}

const url = process.env.MONGODB_URI;
let db;

const connectDB = async () => {
  if (db) return db;
  
  const client = new MongoClient(url, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    tls: true,
    // Removido directConnection ya que no es compatible con SRV
    retryWrites: true,
    w: 'majority'
  });

  try {
    console.log('Intentando conectar a MongoDB Atlas...');
    await client.connect();
    console.log('MongoDB connected successfully');
    
    db = client.db(process.env.MONGODB_DB_NAME || 'testdb');
    return db;
  } catch (error) {
    console.error('Error de conexión a MongoDB:', {
      message: error.message,
      code: error.code,
      name: error.name
    });
    throw error;
  }
};

module.exports = connectDB;