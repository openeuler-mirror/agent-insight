import argparse
import json
from pathlib import Path
import sys

from .control import SQLiteControlStore, StorageError
from .legacy import inventory_database, export_database, verify_export, LegacyValidationError


def main(argv=None):
    parser=argparse.ArgumentParser(description='Core storage: explicit isolated targets and read-only legacy migration inputs')
    commands=parser.add_subparsers(dest='command',required=True)
    schema=commands.add_parser('schema',help='print reviewed DDL; does not connect to a database')
    schema.add_argument('--backend',required=True,choices=['sqlite','postgresql','opengauss','clickhouse'])
    initialize=commands.add_parser('init-sqlite',help='initialize an explicit NEW core SQLite database')
    initialize.add_argument('--database',required=True)
    inspect=commands.add_parser('inspect-legacy',help='read-only consistent legacy inventory (may scan large tables)')
    inspect.add_argument('--database',required=True)
    export=commands.add_parser('export-legacy',help='write a private consistent raw export; never modifies source')
    export.add_argument('--database',required=True)
    export.add_argument('--output',required=True)
    verify=commands.add_parser('verify-export',help='verify export bytes, schema and typed-row hashes')
    verify.add_argument('--directory',required=True)
    args=parser.parse_args(argv)
    try:
        if args.command=='schema':
            print((Path(__file__).parent/'schema'/args.backend/'001_core.sql').read_text(),end='')
            return 0
        if args.command=='init-sqlite':
            SQLiteControlStore(args.database).initialize()
            result={'status':'initialized','schema_version':1,'database':str(Path(args.database).absolute())}
        elif args.command=='inspect-legacy':
            result=inventory_database(args.database)
        elif args.command=='export-legacy':
            result=export_database(args.database,args.output)
        else:
            result=verify_export(args.directory)
        if args.command in {'inspect-legacy','export-legacy','verify-export'}:
            tables = result['tables']
            result = {key:result[key] for key in ('format_version','status','integrity_status','source_schema_sha256','source_content_sha256','unclassified_tables') if key in result} | {'tables': [{key:table[key] for key in ('name','row_count','rows_sha256','classification') if key in table} for table in tables]}
        print(json.dumps(result,ensure_ascii=False,sort_keys=True))
        return 0
    except (StorageError,LegacyValidationError,OSError,ValueError) as exc:
        print(json.dumps({'error':type(exc).__name__,'message':str(exc)},ensure_ascii=False),file=sys.stderr)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
