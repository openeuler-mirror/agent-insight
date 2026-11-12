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
    schema.add_argument('--version',type=int,default=1)
    initialize=commands.add_parser('init-sqlite',help='initialize an explicit NEW core SQLite database')
    initialize.add_argument('--database',required=True)
    inspect=commands.add_parser('inspect-legacy',help='read-only consistent legacy inventory (may scan large tables)')
    inspect.add_argument('--database',required=True)
    export=commands.add_parser('export-legacy',help='write a private consistent raw export; never modifies source')
    export.add_argument('--database',required=True)
    export.add_argument('--output',required=True)
    verify=commands.add_parser('verify-export',help='verify export bytes, schema and typed-row hashes')
    verify.add_argument('--directory',required=True)
    migration_plan=commands.add_parser('migration-plan',help='read-only known-prefix migration plan for explicit target')
    migration_plan.add_argument('--backend',required=True,choices=['sqlite','postgresql','opengauss'])
    migration_plan.add_argument('--database')
    migration_plan.add_argument('--dsn-file')
    migration_plan.add_argument('--schema')
    migration_plan.add_argument('--artifacts')
    migrate=commands.add_parser('migrate-sqlite',help='explicit atomic schema upgrade, new private sibling backup required')
    migrate.add_argument('--database',required=True)
    migrate.add_argument('--backup',required=True)
    for command in ('init-relational','migrate-relational','source-evidence'):
        relational=commands.add_parser(command,help='explicit isolated-schema relational operation')
        relational.add_argument('--backend',required=True,choices=['postgresql','opengauss'])
        relational.add_argument('--dsn-file',required=True)
        relational.add_argument('--schema',required=True)
        relational.add_argument('--artifacts',required=True)
        if command=='migrate-relational': relational.add_argument('--backup-manifest',required=True)
    args=parser.parse_args(argv)
    try:
        if args.command=='schema':
            if args.version < 1: raise ValueError('migration version must be positive')
            files=list((Path(__file__).parent/'schema'/args.backend).glob(f'{args.version:03d}_*.sql'))
            if len(files)!=1: raise ValueError('unknown migration version')
            print(files[0].read_text(),end='')
            return 0
        if args.command=='init-sqlite':
            SQLiteControlStore(args.database).initialize()
            result={'status':'initialized','schema_version':SQLiteControlStore(args.database).migration_plan()['current_version'],'database':str(Path(args.database).absolute())}
        elif args.command=='migrate-sqlite':
            result=SQLiteControlStore(args.database).migrate(backup_path=args.backup)
        elif args.command in {'init-relational','migrate-relational','migration-plan','source-evidence'}:
            if args.backend=='sqlite':
                if not args.database: raise ValueError('SQLite requires an explicit database')
                store=SQLiteControlStore(args.database)
            else:
                if not args.dsn_file or not args.schema or not args.artifacts:
                    raise ValueError('relational operations require DSN file, schema and artifact directory')
                from .relational import PostgreSQLControlStore, OpenGaussControlStore
                dsn_file=Path(args.dsn_file)
                if not dsn_file.is_file() or dsn_file.is_symlink() or dsn_file.stat().st_mode & 0o077:
                    raise ValueError('DSN file must be private and not a symlink')
                cls=PostgreSQLControlStore if args.backend=='postgresql' else OpenGaussControlStore
                store=cls.from_dsn(dsn_file.read_text().strip(),schema=args.schema,artifact_directory=args.artifacts)
            if args.command=='init-relational':
                store.initialize();result={'status':'initialized'} | store.migration_plan()
            elif args.command=='source-evidence':
                result=store.source_evidence()
            elif args.command=='migrate-relational':
                result=store.migrate(backup_manifest=json.loads(Path(args.backup_manifest).read_text()))
            else: result=store.migration_plan()
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
