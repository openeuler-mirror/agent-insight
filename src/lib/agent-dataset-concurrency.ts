export interface DatasetSnapshotVersion {
  _storageEtag?: string;
}

function checkedEtag(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^"[\x21\x23-\x7e]{1,510}"$/.test(value)) {
    throw Object.assign(new Error('保存失败'), { status: 409 });
  }
  return value;
}

export function captureDatasetSnapshot<T extends object>(value: T, headers: Pick<Headers, 'get'>): T & DatasetSnapshotVersion {
  const stored = checkedEtag((value as DatasetSnapshotVersion)._storageEtag);
  const received = checkedEtag(headers.get('etag') ?? undefined);
  if (stored !== undefined && received !== undefined && stored !== received) {
    throw Object.assign(new Error('保存失败'), { status: 409 });
  }
  const etag = received ?? stored;
  return etag === undefined ? value : { ...value, _storageEtag: etag };
}

export function datasetWriteHeaders(...snapshots: Array<DatasetSnapshotVersion | null | undefined>): Record<string, string> {
  let selected: string | undefined;
  for (const snapshot of snapshots) {
    const etag = checkedEtag(snapshot?._storageEtag);
    if (selected !== undefined && etag !== undefined && selected !== etag) {
      throw Object.assign(new Error('保存失败'), { status: 409 });
    }
    selected ??= etag;
  }
  return selected === undefined ? {} : { 'If-Match': selected };
}
