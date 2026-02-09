/**
 * Dynamic API Configuration Manager
 * Allows runtime switching of ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

export interface ApiConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  description?: string;
}

interface ConfigStore {
  current: string;  // Name of current config
  configs: Record<string, ApiConfig>;
}

const CONFIG_FILE = path.join(DATA_DIR, 'api-configs.json');

let cachedStore: ConfigStore | null = null;

function loadStore(): ConfigStore {
  if (cachedStore) return cachedStore;

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      cachedStore = JSON.parse(data);
      return cachedStore!;
    }
  } catch (err) {
    console.error('Failed to load API config store:', err);
  }

  // Default: use environment variables
  const defaultConfig: ApiConfig = {
    name: 'default',
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    description: 'Default from environment variables'
  };

  cachedStore = {
    current: 'default',
    configs: { default: defaultConfig }
  };

  return cachedStore;
}

function saveStore(store: ConfigStore): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2));
    cachedStore = store;
  } catch (err) {
    throw new Error(`Failed to save API config: ${err}`);
  }
}

export function getCurrentConfig(): ApiConfig {
  const store = loadStore();
  const config = store.configs[store.current];
  if (!config) {
    throw new Error(`Current config "${store.current}" not found`);
  }
  return config;
}

export function listConfigs(): ApiConfig[] {
  const store = loadStore();
  return Object.values(store.configs);
}

export function addConfig(config: ApiConfig): void {
  const store = loadStore();
  store.configs[config.name] = config;
  saveStore(store);
}

export function removeConfig(name: string): void {
  const store = loadStore();
  if (name === 'default') {
    throw new Error('Cannot remove default config');
  }
  if (store.current === name) {
    throw new Error('Cannot remove current config. Switch to another config first.');
  }
  delete store.configs[name];
  saveStore(store);
}

export function switchConfig(name: string): ApiConfig {
  const store = loadStore();
  const config = store.configs[name];
  if (!config) {
    throw new Error(`Config "${name}" not found`);
  }
  store.current = name;
  saveStore(store);
  return config;
}

export function getCurrentConfigName(): string {
  const store = loadStore();
  return store.current;
}

/**
 * Test if an API configuration is valid by making a simple API call
 */
export async function testApiConfig(config: ApiConfig): Promise<{ valid: boolean; error?: string }> {
  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'test' }]
      })
    });

    // Accept both 200 (success) and 400 (bad request but API is reachable)
    // Reject 401 (unauthorized), 403 (forbidden), 404 (not found)
    if (response.status === 401) {
      return { valid: false, error: 'Invalid API key (401 Unauthorized)' };
    }
    if (response.status === 403) {
      return { valid: false, error: 'Access forbidden (403 Forbidden)' };
    }
    if (response.status === 404) {
      return { valid: false, error: 'API endpoint not found (404)' };
    }
    if (response.status >= 500) {
      return { valid: false, error: `Server error (${response.status})` };
    }

    // 200 or 400 means API is reachable and key is valid
    return { valid: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Connection failed: ${errorMsg}` };
  }
}
