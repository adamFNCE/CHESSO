import { createClient } from 'redis';

class BaseGameStore {
  async createRoom(snapshot) {
    return this.saveRoom(snapshot);
  }

  async getRoom(_roomId) {
    return null;
  }

  async saveRoom(_snapshot) {
    return null;
  }

  async deleteRoom(_roomId) {}
}

export class InMemoryGameStore extends BaseGameStore {
  constructor() {
    super();
    this.rooms = new Map();
  }

  async getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  async saveRoom(snapshot) {
    this.rooms.set(snapshot.id, snapshot);
    return snapshot;
  }

  async deleteRoom(roomId) {
    this.rooms.delete(roomId);
  }
}

export class RedisGameStore extends BaseGameStore {
  constructor(client, keyPrefix = 'chesso:room:') {
    super();
    this.client = client;
    this.keyPrefix = keyPrefix;
  }

  key(roomId) {
    return `${this.keyPrefix}${roomId}`;
  }

  async getRoom(roomId) {
    const raw = await this.client.get(this.key(roomId));
    return raw ? JSON.parse(raw) : null;
  }

  async saveRoom(snapshot) {
    await this.client.set(this.key(snapshot.id), JSON.stringify(snapshot));
    return snapshot;
  }

  async deleteRoom(roomId) {
    await this.client.del(this.key(roomId));
  }
}

export async function createGameStore({ type, redisUrl, keyPrefix, logger = console } = {}) {
  if (type === 'redis') {
    if (!redisUrl) {
      logger.warn('GAMESTORE_TYPE=redis but REDIS_URL missing; falling back to in-memory store');
      return new InMemoryGameStore();
    }

    try {
      const client = createClient({ url: redisUrl });
      client.on('error', (err) => {
        logger.error('Redis client error:', err.message);
      });
      await client.connect();
      logger.log('GameStore: Redis connected');
      return new RedisGameStore(client, keyPrefix);
    } catch (err) {
      logger.error('Redis connection failed; using in-memory store:', err.message);
      return new InMemoryGameStore();
    }
  }

  logger.log('GameStore: In-memory');
  return new InMemoryGameStore();
}
