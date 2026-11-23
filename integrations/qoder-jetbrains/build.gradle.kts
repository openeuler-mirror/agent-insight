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

plugins {
    java
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "org.openeuler.agentinsight"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        val localIdePath = providers.gradleProperty("localIdePath")
        if (localIdePath.isPresent) {
            local(localIdePath)
        } else {
            pycharmCommunity(providers.gradleProperty("platformVersion"))
        }
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "233"
        }
    }
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

tasks {
    withType<JavaCompile> {
        options.release = 17
        options.encoding = "UTF-8"
    }
    processResources {
        from("../../scripts/qoder_trace_collector.mjs") { into("collector") }
        from("../../scripts/qoder_uploader_client.mjs") { into("collector") }
        from("../../scripts/qoder_setup.mjs") { into("collector") }
        from("../../scripts/qoder_token_usage_env.mjs") { into("collector") }
    }
}
