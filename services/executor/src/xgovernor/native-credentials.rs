/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::path::Path;

// 直接编译上游实现，包含白盒/SDF 解密及 api_keys、tokens、环境变量的优先级。
#[allow(dead_code)]
mod native_secrets {
    include!(env!("INSIGHT_XIAOO_SECRET_PROVIDER"));
}

fn failure(code: &str) -> Value {
    json!({"schemaVersion": 1, "error": code})
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

fn resolve(input: &Value) -> Value {
    let Some(file) = text(input, "configPath") else {
        return failure("MODEL_CONFIGURATION_INVALID");
    };
    let path = Path::new(file);
    let content = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return failure("MODEL_CONFIG_UNREADABLE"),
    };
    let config: toml::Value = match toml::from_str(&content) {
        Ok(value) => value,
        Err(_) => return failure("MODEL_CONFIG_INVALID"),
    };
    let config = match serde_json::to_value(config) {
        Ok(value) => value,
        Err(_) => return failure("MODEL_CONFIG_INVALID"),
    };
    let Some(mut llm) = config.get("llm").cloned() else {
        return failure("MODEL_CONFIG_INVALID");
    };
    let selected = text(input, "modelId").unwrap_or("");
    if let Some(profiles) = llm
        .get("profiles")
        .and_then(Value::as_object)
        .filter(|p| !p.is_empty())
    {
        let active = text(&llm, "active_profile").and_then(|id| profiles.get(id));
        let matches = |p: &&Value| {
            p.get("enabled") != Some(&Value::Bool(false))
                && selected
                    == format!(
                        "{}/{}",
                        text(p, "provider").unwrap_or(""),
                        text(p, "model").unwrap_or("")
                    )
        };
        let matching: Vec<_> = profiles.values().filter(matches).collect();
        let profile = if selected.is_empty() || active.is_some_and(|p| matches(&p)) {
            active
        } else if matching.len() == 1 {
            Some(matching[0])
        } else if matching.is_empty() {
            active
        } else {
            None
        };
        let Some(profile) = profile.filter(|p| p.get("enabled") != Some(&Value::Bool(false)))
        else {
            return failure("MODEL_PROFILE_INVALID");
        };
        llm = profile.clone();
    }
    let Some(provider) = text(&llm, "provider").filter(|s| !s.is_empty()) else {
        return failure("MODEL_CONFIG_INVALID");
    };
    if !selected.is_empty() {
        let Some((requested_provider, model)) = selected.split_once('/') else {
            return failure("MODEL_PROFILE_INVALID");
        };
        if requested_provider != provider || model.is_empty() {
            return failure("MODEL_PROFILE_INVALID");
        }
        llm["model"] = Value::String(model.into());
    }
    let Some(provider) = text(&llm, "provider") else {
        return failure("MODEL_CONFIG_INVALID");
    };
    let Some(profile) = llm_client::resolve_provider_profile(provider) else {
        return failure("MODEL_PROVIDER_UNSUPPORTED");
    };
    let env_name = text(&llm, "api_key_env").or(profile.default_api_key_env);
    if let Some(name) = env_name {
        if name.is_empty()
            || !name
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit())
        {
            return failure("MODEL_CONFIG_INVALID");
        }
    }
    let store = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("llm_secrets.json");
    // 旧版上游会删除单字节损坏文件；凭据探测只读，留给原生工具修复。
    if std::fs::metadata(&store).is_ok_and(|m| m.len() == 1) {
        return failure("MODEL_CREDENTIAL_STORE_UNREADABLE");
    }
    let secrets = native_secrets::SecretProvider::new(
        store,
        config
            .pointer("/vault/use_sdf")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );
    let credential = match env_name {
        Some(name) => match secrets.get_secret(name) {
            Ok(value) if !value.trim().is_empty() => Some(value),
            Ok(_) => {
                return json!({"schemaVersion":1, "error":"MODEL_CREDENTIAL_MISSING", "environment":name})
            }
            Err(cause)
                if cause.to_string()
                    == format!("API key environment variable {} not found", name) =>
            {
                if !profile.api_key_required && text(&llm, "api_key_env").is_none() {
                    None
                } else {
                    return json!({"schemaVersion":1, "error":"MODEL_CREDENTIAL_MISSING", "environment":name});
                }
            }
            Err(_) => return failure("MODEL_CREDENTIAL_STORE_UNREADABLE"),
        },
        None => None,
    };
    let credential_required = profile.api_key_required || env_name.is_some();
    let resolved = match llm_client::resolve_config(llm_client::ResolveInput {
        provider: Some(provider.into()),
        api_key: credential,
        // 凭据已按原生库优先级解析，避免 resolver 再读环境变量覆盖它。
        api_key_env: None,
        base_url: text(&llm, "api_base").map(String::from),
        ..Default::default()
    }) {
        Ok(value) => value,
        Err(llm_client::ResolveError::MissingApiKey) => return failure("MODEL_CREDENTIAL_MISSING"),
        Err(_) => return failure("MODEL_CONFIG_INVALID"),
    };
    llm["api_base"] = Value::String(resolved.base_url);
    if let Some(values) = llm.as_object_mut() {
        values.retain(|key, _| {
            [
                "provider",
                "model",
                "api_base",
                "api_key_env",
                "api",
                "context_window",
                "max_tokens",
                "reasoning_effort",
                "kvcache_enabled",
                "kvcache_debug_enabled",
            ]
            .contains(&key.as_str())
        });
    }
    json!({"schemaVersion":1, "llm":llm, "credential":resolved.api_key, "credentialRequired":credential_required})
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--describe") {
        println!("{{\"schemaVersion\":1,\"bridgeVersion\":1}}");
        return;
    }
    let mut input = String::new();
    let output = if std::io::stdin()
        .take(65537)
        .read_to_string(&mut input)
        .is_ok()
        && input.len() <= 65536
    {
        serde_json::from_str(&input)
            .map(|value| resolve(&value))
            .unwrap_or_else(|_| failure("MODEL_CONFIG_INVALID"))
    } else {
        failure("MODEL_CONFIG_INVALID")
    };
    let mut pipe = unsafe { std::fs::File::from_raw_fd(3) };
    if serde_json::to_writer(&mut pipe, &output).is_err() || pipe.flush().is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        dir: std::path::PathBuf,
        file: std::path::PathBuf,
        name: String,
    }
    impl Fixture {
        fn new() -> Self {
            let name = format!(
                "INSIGHT_NATIVE_TEST_{}_{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            );
            let dir = std::env::temp_dir().join(&name);
            std::fs::create_dir(&dir).unwrap();
            let file = dir.join("config.toml");
            std::fs::write(&file, format!("[llm]\nprovider='local'\nmodel='test'\napi_base='http://127.0.0.1:9/v1'\napi_key_env='{name}'\n")).unwrap();
            Self { dir, file, name }
        }
        fn store(&self, value: Value) {
            let key = vault::WhiteBoxKeyProvider::new("default")
                .get_key()
                .unwrap();
            let nonce = [7u8; 12];
            let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
            let mut bytes = vec![1];
            bytes.extend(nonce);
            bytes.extend(
                cipher
                    .encrypt(
                        Nonce::from_slice(&nonce),
                        serde_json::to_vec(&value).unwrap().as_slice(),
                    )
                    .unwrap(),
            );
            std::fs::write(self.dir.join("llm_secrets.json"), bytes).unwrap();
        }
        fn resolve(&self) -> Value {
            resolve(&json!({"configPath":self.file,"modelId":"local/experiment"}))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::env::remove_var(&self.name);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    #[test]
    fn native_store_keys_then_tokens_then_environment() {
        let f = Fixture::new();
        std::env::set_var(&f.name, "env-fixture");
        f.store(json!({"api_keys":{(f.name.clone()):"key-fixture"},"tokens":{(f.name.clone()):"token-fixture"}}));
        let before = std::fs::read(f.dir.join("llm_secrets.json")).unwrap();
        assert_eq!(f.resolve()["credential"], "key-fixture");
        assert_eq!(
            std::fs::read(f.dir.join("llm_secrets.json")).unwrap(),
            before
        );
        f.store(json!({"tokens":{(f.name.clone()):"token-fixture"}}));
        assert_eq!(f.resolve()["credential"], "token-fixture");
        f.store(json!({"api_keys":{"unrelated":"other-fixture"}}));
        assert_eq!(f.resolve()["credential"], "env-fixture");
        std::env::remove_var(&f.name);
        assert_eq!(f.resolve()["error"], "MODEL_CREDENTIAL_MISSING");
        assert_eq!(f.resolve()["environment"], f.name);
    }
    #[test]
    fn missing_store_and_blank_credentials_are_distinct_from_corruption() {
        let f = Fixture::new();
        std::env::set_var(&f.name, "environment-fixture");
        assert_eq!(f.resolve()["credential"], "environment-fixture");
        f.store(json!({"api_keys":{(f.name.clone()):" "}}));
        assert_eq!(f.resolve()["error"], "MODEL_CREDENTIAL_MISSING");
        for bytes in [vec![1], vec![1, 2, 3], vec![99; 30]] {
            std::fs::write(f.dir.join("llm_secrets.json"), &bytes).unwrap();
            assert_eq!(f.resolve()["error"], "MODEL_CREDENTIAL_STORE_UNREADABLE");
            assert_eq!(
                std::fs::read(f.dir.join("llm_secrets.json")).unwrap(),
                bytes
            );
        }
    }
    #[test]
    fn native_provider_default_credential_reference_and_base_url() {
        let f = Fixture::new();
        std::fs::write(&f.file, "[llm]\nprovider='deepseek'\nmodel='test'\n").unwrap();
        f.store(json!({"api_keys":{"DEEPSEEK_API_KEY":"default-fixture"}}));
        let result = resolve(&json!({"configPath":f.file,"modelId":"deepseek/selected"}));
        assert_eq!(result["credential"], "default-fixture");
        assert_eq!(result["llm"]["model"], "selected");
        assert!(result["llm"]["api_base"]
            .as_str()
            .unwrap()
            .starts_with("https://"));
    }
    #[test]
    fn profiles_follow_experiment_selection_and_disabled_profiles_are_rejected() {
        let f = Fixture::new();
        std::env::set_var(&f.name, "profile-fixture");
        std::fs::write(&f.file, format!("[llm]\nactive_profile='a'\n[llm.profiles.a]\nprovider='local'\nmodel='a'\napi_base='http://127.0.0.1:9/v1'\napi_key_env='{0}'\n[llm.profiles.b]\nprovider='deepseek'\nmodel='b'\napi_key_env='{0}'\nmax_tokens=100\n", f.name)).unwrap();
        let result = resolve(&json!({"configPath":f.file,"modelId":"deepseek/b"}));
        assert_eq!(result["credential"], "profile-fixture");
        assert_eq!(result["llm"]["model"], "b");
        assert_eq!(result["llm"]["max_tokens"], 100);
        let current = resolve(&json!({"configPath":f.file,"modelId":""}));
        assert_eq!(current["llm"]["model"], "a");
        let content = std::fs::read_to_string(&f.file)
            .unwrap()
            .replace("active_profile='a'", "active_profile='missing'");
        std::fs::write(&f.file, content).unwrap();
        assert_eq!(
            resolve(&json!({"configPath":f.file}))["error"],
            "MODEL_PROFILE_INVALID"
        );
        let content = std::fs::read_to_string(&f.file)
            .unwrap()
            .replace("active_profile='missing'", "active_profile='a'")
            .replace("[llm.profiles.b]", "[llm.profiles.b]\nenabled=false");
        std::fs::write(&f.file, content).unwrap();
        assert_eq!(
            resolve(&json!({"configPath":f.file,"modelId":"deepseek/b"}))["error"],
            "MODEL_PROFILE_INVALID"
        );
    }
    #[test]
    fn optional_auth_and_invalid_configuration_do_not_claim_a_bad_key() {
        let f = Fixture::new();
        std::fs::write(
            &f.file,
            "[llm]\nprovider='local'\nmodel='test'\napi_base='http://127.0.0.1:9/v1'\n",
        )
        .unwrap();
        assert_eq!(f.resolve()["credentialRequired"], false);
        std::fs::write(&f.file, "[llm broken").unwrap();
        assert_eq!(f.resolve()["error"], "MODEL_CONFIG_INVALID");
        std::fs::remove_file(&f.file).unwrap();
        assert_eq!(f.resolve()["error"], "MODEL_CONFIG_UNREADABLE");
    }
}
