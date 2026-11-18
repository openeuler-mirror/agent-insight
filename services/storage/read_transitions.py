from .control import Conflict, StorageError


class TraceIndexing(StorageError):
    status = 503
    code = 'TRACE_INDEXING'


class TraceReadChanged(Conflict):
    status = 409
    code = 'TRACE_READ_CHANGED'
