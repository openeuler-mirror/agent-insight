import DatasetItemsPage from '@/components/DatasetItemsPage';
import VersionedDatasetDetail from '@/components/evaluation-harness/VersionedDatasetDetail';
export default async function DatasetDataItemsRoutePage({params}: {params: Promise<{id:string}>}) {
  const {id} = await params;
  return <div style={{flex:1,minHeight:0,display:'flex',flexDirection:'column'}}>{id.startsWith('versioned-') ? <VersionedDatasetDetail key={id} assetId={id.slice(10)}/> : <DatasetItemsPage/>}</div>;
}
