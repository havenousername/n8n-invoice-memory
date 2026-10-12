// Who files for each office, and who manages each shard. Mirrors samples/offices.json (offices.test.ts checks it).
export const CONTROLLERS: Record<string, string> = {
  berlin: 'Tom', munich: 'Tom', vienna: 'Lena', amsterdam: 'Jules', paris: 'Jules', london: 'Mia',
};

export const MANAGER_NAMES = {
  m_anna: { name: 'Anna', region: 'Central' },
  m_ben: { name: 'Ben', region: 'West' },
} as const;

export type ManagerId = keyof typeof MANAGER_NAMES;
