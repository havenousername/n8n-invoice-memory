import { Suspense } from 'react';
import { ManagerView } from '@/components/ManagerView';
import { MANAGER_NAMES, type ManagerId } from '@/lib/offices';

// The aisle screen. `?manager=m_ben` opens Ben's shard.
export default function Page({ searchParams }: { searchParams: Promise<{ manager?: string }> }) {
  return (
    <Suspense fallback={null}>
      <View searchParams={searchParams} />
    </Suspense>
  );
}

async function View({ searchParams }: { searchParams: Promise<{ manager?: string }> }) {
  const { manager } = await searchParams;
  const initial: ManagerId = manager && manager in MANAGER_NAMES ? (manager as ManagerId) : 'm_anna';
  return <ManagerView initialManager={initial} />;
}
