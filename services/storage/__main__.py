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
    legacy_plan=commands.add_parser('plan-legacy',help='bounded read-only semantic plan; no destination connection or apply')
    legacy_plan.add_argument('--database',required=True)
    legacy_plan.add_argument('--source-id',required=True)
    legacy_plan.add_argument('--bindings-file')
    legacy_plan.add_argument('--max-rows',type=int,default=100000)
    legacy_plan.add_argument('--max-bytes',type=int,default=64*1024*1024)
    legacy_plan.add_argument('--max-issues',type=int,default=256)
    legacy_plan.add_argument('--max-seconds',type=float,default=15)
    export=commands.add_parser('export-legacy',help='write a private consistent raw export; never modifies source')
    export.add_argument('--database',required=True)
    export.add_argument('--output',required=True)
    verify=commands.add_parser('verify-export',help='verify export bytes, schema and typed-row hashes')
    verify.add_argument('--directory',required=True)
    for command in ('plan-legacy-import','apply-legacy-import','verify-legacy-import'):
        semantic=commands.add_parser(command,help='explicit verified export and target; no service startup or production cutover')
        semantic.add_argument('--directory',required=True)
        semantic.add_argument('--source-id',required=True)
        semantic.add_argument('--bindings-file',required=True)
        semantic.add_argument('--config',required=True)
        semantic.add_argument('--actors-file',required=command!='plan-legacy-import')
        semantic.add_argument('--migration-id',required=command!='plan-legacy-import')
        semantic.add_argument('--row-bindings-file')
        semantic.add_argument('--files-file')
        semantic.add_argument('--skill-directories-file')
        semantic.add_argument('--message-order-file')
        semantic.add_argument('--model',action='append',dest='selected_models')
        semantic.add_argument('--node-binary',default='node')
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
        elif args.command=='plan-legacy':
            from .legacy_plan import plan_database
            bindings=None
            if args.bindings_file:
                source=Path(args.bindings_file)
                if not source.is_file() or source.is_symlink() or source.stat().st_mode & 0o077 or source.stat().st_size>1024*1024:
                    raise LegacyValidationError('Bindings file must be private, bounded and not a symlink')
                try:
                    bindings=json.loads(source.read_text())
                except (ValueError,UnicodeError):
                    raise LegacyValidationError('Bindings file is not valid JSON') from None
            result=plan_database(args.database,source_id=args.source_id,bindings=bindings,
                max_rows=args.max_rows,max_bytes=args.max_bytes,max_issues=args.max_issues,max_seconds=args.max_seconds)
        elif args.command=='export-legacy':
            result=export_database(args.database,args.output)
        elif args.command in {'plan-legacy-import','apply-legacy-import','verify-legacy-import'}:
            from .legacy_import import LegacyImport
            from .trace_service import runtime_from_config
            def private_json(value,limit=1024*1024):
                if value is None:return None
                path=Path(value)
                if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077 or path.stat().st_size>limit:
                    raise LegacyValidationError('Import input must be a private bounded regular JSON file')
                with path.open() as source:return json.load(source)
            bindings=private_json(args.bindings_file)
            actors=private_json(args.actors_file)
            rows=private_json(args.row_bindings_file)
            files=private_json(args.files_file,256*1024*1024)
            directories=private_json(args.skill_directories_file)
            message_order=private_json(args.message_order_file)
            runtime,_=runtime_from_config(args.config)
            tool=LegacyImport(runtime.control,args.directory,source_id=args.source_id,bindings=bindings,actors=actors,
                row_bindings=rows,files=files,skill_directories=directories,message_order=message_order,selected_models=args.selected_models,
                ingest=runtime.ingest,facts=runtime.facts,node_binary=args.node_binary)
            result=tool.plan() if args.command=='plan-legacy-import' else tool.apply(migration_id=args.migration_id) if args.command=='apply-legacy-import' else tool.verify(migration_id=args.migration_id)
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
