#!/usr/bin/env python3
import os
import sys
import logging
import uuid

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

try:
    import psycopg2
    from psycopg2 import Error
except ImportError:
    logger.error("未找到 psycopg2 模块。请使用 'pip install psycopg2-binary' 安装。")
    sys.exit(1)

TABLE_DEFINITIONS = {
    "User": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("username", "TEXT UNIQUE NOT NULL"),
            ("apiKey", "TEXT UNIQUE NOT NULL"),
            ("createdAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ],
        "unique_constraints": []
    },
    "Skill": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("name", "TEXT NOT NULL"),
            ("category", "TEXT DEFAULT 'Other'"),
            ("description", "TEXT"),
            ("tags", "TEXT"),
            ("visibility", "TEXT DEFAULT 'private'"),
            ("author", "TEXT"),
            ("user", "TEXT"),
            ("createdAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ("updatedAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ("activeVersion", "INTEGER DEFAULT 0"),
            ("isUploaded", "BOOLEAN DEFAULT FALSE"),
        ],
        "unique_constraints": ["UNIQUE(name, \"user\")"]
    },
    "SkillVersion": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("skillId", "TEXT NOT NULL"),
            ("version", "INTEGER NOT NULL"),
            ("content", "TEXT NOT NULL"),
            ("assetPath", "TEXT"),
            ("files", "TEXT"),
            ("changeLog", "TEXT"),
            ("createdAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ],
        "unique_constraints": ["UNIQUE(\"skillId\", version)"],
        "foreign_keys": ["FOREIGN KEY (\"skillId\") REFERENCES \"Skill\"(id) ON DELETE CASCADE"]
    },
    "Execution": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("taskId", "TEXT"),
            ("query", "TEXT"),
            ("framework", "TEXT"),
            ("tokens", "INTEGER"),
            ("cost", "FLOAT"),
            ("latency", "FLOAT"),
            ("timestamp", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ("model", "TEXT"),
            ("finalResult", "TEXT"),
            ("skill", "TEXT"),
            ("skills", "TEXT"),
            ("isSkillCorrect", "BOOLEAN DEFAULT FALSE"),
            ("isAnswerCorrect", "BOOLEAN DEFAULT FALSE"),
            ("answerScore", "FLOAT"),
            ("skillScore", "FLOAT"),
            ("judgmentReason", "TEXT"),
            ("failures", "TEXT"),
            ("skillIssues", "TEXT"),
            ("skillVersion", "INTEGER"),
            ("label", "TEXT"),
            ("user", "TEXT"),
            ("toolCallCount", "INTEGER"),
            ("llmCallCount", "INTEGER"),
            ("inputTokens", "INTEGER"),
            ("outputTokens", "INTEGER"),
            ("toolCallErrorCount", "INTEGER"),
            ("cacheReadInputTokens", "INTEGER"),
            ("cacheCreationInputTokens", "INTEGER"),
            ("maxSingleCallTokens", "INTEGER"),
        ],
        "unique_constraints": []
    },
    "Config": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("query", "TEXT NOT NULL"),
            ("skill", "TEXT NOT NULL"),
            ("standardAnswer", "TEXT NOT NULL"),
            ("rootCauses", "TEXT"),
            ("keyActions", "TEXT"),
            ("user", "TEXT"),
            ("parseStatus", "TEXT DEFAULT 'completed'"),
        ],
        "unique_constraints": ["UNIQUE(query, \"user\")"]
    },
    "Session": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("taskId", "TEXT UNIQUE NOT NULL"),
            ("label", "TEXT"),
            ("query", "TEXT"),
            ("startTime", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ("endTime", "TIMESTAMP"),
            ("interactions", "TEXT"),
            ("langfuseTraceNodes", "TEXT"),
            ("user", "TEXT"),
            ("model", "TEXT"),
        ],
        "unique_constraints": []
    },
    "UserSettings": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("user", "TEXT UNIQUE NOT NULL"),
            ("settingsJson", "TEXT NOT NULL"),
            ("createdAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ("updatedAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ],
        "unique_constraints": []
    },
    "ParsedFlow": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("skillId", "TEXT NOT NULL"),
            ("version", "INTEGER NOT NULL"),
            ("user", "TEXT"),
            ("flowJson", "TEXT NOT NULL"),
            ("mermaidCode", "TEXT NOT NULL"),
            ("parsedAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ],
        "unique_constraints": ["UNIQUE(\"skillId\", version, \"user\")"]
    },
    "ExecutionMatch": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("executionId", "TEXT UNIQUE NOT NULL"),
            ("skillId", "TEXT NOT NULL"),
            ("skillVersion", "INTEGER NOT NULL"),
            ("user", "TEXT"),
            ("matchJson", "TEXT NOT NULL"),
            ("staticMermaid", "TEXT NOT NULL"),
            ("dynamicMermaid", "TEXT NOT NULL"),
            ("analysisText", "TEXT"),
            ("interactionCount", "INTEGER NOT NULL"),
            ("matchedAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ],
        "unique_constraints": []
    },
    "UserGuideState": {
        "columns": [
            ("id", "TEXT PRIMARY KEY"),
            ("user", "TEXT UNIQUE NOT NULL"),
            ("guideDisabled", "BOOLEAN DEFAULT FALSE"),
            ("currentStep", "INTEGER DEFAULT 0"),
            ("completedSteps", "TEXT DEFAULT '[]'"),
            ("skippedSteps", "TEXT DEFAULT '[]'"),
            ("lastShownAt", "TIMESTAMP"),
            ("dismissedAt", "TIMESTAMP"),
            ("createdAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ("updatedAt", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ],
        "unique_constraints": []
    }
}

def get_existing_columns(cursor, table_name):
    cursor.execute("""
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = %s
    """, (table_name,))
    return [row[0] for row in cursor.fetchall()]

def table_exists(cursor, table_name):
    cursor.execute("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables 
            WHERE table_name = %s
        )
    """, (table_name,))
    return cursor.fetchone()[0]

def init_opengauss_db():
    connection = None
    cursor = None
    try:
        host = os.getenv("DB_HOST", "127.0.0.1")
        port = os.getenv("DB_PORT", "26000")
        dbname = os.getenv("DB_NAME", "postgres")
        user = os.getenv("DB_USER", "omm")
        password = os.getenv("DB_PASSWORD", "")
        
        logger.info(f"正在以用户 {user} 连接到 OpenGauss ({host}:{port})...")
        
        connection = psycopg2.connect(
            host=host,
            port=port,
            dbname=dbname,
            user=user,
            password=password
        )
        connection.autocommit = True
        logger.info("数据库连接成功")
        
        cursor = connection.cursor()
        
        cursor.execute("SELECT version();")
        db_version = cursor.fetchone()
        print(f"成功连接到 OpenGauss！版本: {db_version[0]}\n")

        for table_name, table_def in TABLE_DEFINITIONS.items():
            print(f"处理表: {table_name}")
            
            if not table_exists(cursor, table_name):
                columns_sql = ", ".join([f'"{col[0]}" {col[1]}' for col in table_def["columns"]])
                constraints_sql = ""
                if table_def.get("unique_constraints"):
                    constraints_sql = ", " + ", ".join(table_def["unique_constraints"])
                if table_def.get("foreign_keys"):
                    constraints_sql += ", " + ", ".join(table_def["foreign_keys"])
                
                create_sql = f'CREATE TABLE "{table_name}" ({columns_sql}{constraints_sql})'
                cursor.execute(create_sql)
                print(f"  ✓ 创建表 {table_name}")
            else:
                existing_columns = get_existing_columns(cursor, table_name)
                added_columns = []
                
                for col_name, col_def in table_def["columns"]:
                    if col_name not in existing_columns:
                        alter_sql = f'ALTER TABLE "{table_name}" ADD COLUMN "{col_name}" {col_def}'
                        cursor.execute(alter_sql)
                        added_columns.append(col_name)
                
                if added_columns:
                    print(f"  ✓ 添加缺失列: {', '.join(added_columns)}")
                else:
                    print(f"  ✓ 表结构完整，无需修改")

        print("\nOpenGauss 数据库表结构同步完成。")

        test_user_id = str(uuid.uuid4())
        try:
            insert_query = 'INSERT INTO "User" (id, username, "apiKey") VALUES (%s, %s, %s)'
            record_to_insert = (test_user_id, "GaussDeveloper", "gauss-dev-key")
            cursor.execute(insert_query, record_to_insert)
            connection.commit()
            print("测试用户记录插入成功。")
        except Error as e:
            if e.pgcode == '23505':
                print("测试用户记录已存在，跳过插入。")
                connection.rollback()
            else:
                raise e

        cursor.execute('SELECT * FROM "User" WHERE username = %s', ("GaussDeveloper",))
        record = cursor.fetchone()
        if record:
            print(f"验证用户: ID={record[0]}, Username={record[1]}")

    except (Exception, Error) as error:
        print(f"操作 OpenGauss 时发生错误: {error}")
        if connection:
            connection.rollback()
        sys.exit(1)

    finally:
        if cursor:
            cursor.close()
        if connection:
            connection.close()
            print("\n数据库连接已安全关闭。")

if __name__ == "__main__":
    init_opengauss_db()
