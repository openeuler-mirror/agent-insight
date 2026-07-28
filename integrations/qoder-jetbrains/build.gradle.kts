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
    }
}
