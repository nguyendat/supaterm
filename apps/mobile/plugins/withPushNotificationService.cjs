"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const {
  withDangerousMod,
  withXcodeProject,
  withInfoPlist,
  withEntitlementsPlist,
} = require("expo/config-plugins");
const expoRequire = createRequire(require.resolve("expo/config-plugins"));
const configRequire = createRequire(expoRequire.resolve("@expo/config-plugins"));
const plist = configRequire("@expo/plist").default;
const targetName = "SupacodeNotificationService";

function sourceFiles(projectRoot) {
  const root = path.join(projectRoot, "modules/supacode-push-preview");
  return [
    {
      name: "NotificationService.swift",
      path: path.join(root, "extension/NotificationService.swift"),
    },
    ...fs
      .readdirSync(path.join(root, "Sources/PushPreviewCore"))
      .filter((file) => file.endsWith(".swift"))
      .sort()
      .map((name) => ({ name, path: path.join(root, "Sources/PushPreviewCore", name) })),
  ];
}

function reconcileSources(project, target, sources) {
  const objects = project.hash.project.objects;
  const names = sources.map((source) => source.name);
  let group = Object.entries(objects.PBXGroup).find(
    ([id, item]) => !id.endsWith("_comment") && item.path?.replaceAll('"', "") === targetName,
  );
  if (!group) {
    const added = project.addPbxGroup([], targetName, targetName);
    project.addToPbxGroup(added.uuid, project.getFirstProject().firstProject.mainGroup);
    group = [added.uuid, added.pbxGroup];
  }
  for (const name of [...names, "Info.plist", `${targetName}.entitlements`]) {
    if (
      !group[1].children.some(
        (child) => objects.PBXFileReference[child.value]?.path?.replaceAll('"', "") === name,
      )
    ) {
      project.addFile(name, group[0]);
    }
  }
  const sourcePhase = objects.PBXNativeTarget[target].buildPhases.find(
    (reference) => objects.PBXSourcesBuildPhase?.[reference.value],
  );
  const phase = sourcePhase
    ? objects.PBXSourcesBuildPhase[sourcePhase.value]
    : project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", target).buildPhase;
  const references = new Map(
    group[1].children.map((child) => [
      objects.PBXFileReference[child.value]?.path?.replaceAll('"', ""),
      child.value,
    ]),
  );
  const previous = new Map(
    phase.files.map((file) => [objects.PBXBuildFile[file.value]?.fileRef, file]),
  );
  phase.files = names.map((name) => {
    const fileRef = references.get(name);
    const existing = previous.get(fileRef);
    if (existing) return existing;
    const id = project.generateUuid();
    objects.PBXBuildFile[id] = { isa: "PBXBuildFile", fileRef, fileRef_comment: name };
    objects.PBXBuildFile[`${id}_comment`] = `${name} in Sources`;
    return { value: id, comment: `${name} in Sources` };
  });
}

function withExtensionConfig(config, bundleIdentifier, entitlements) {
  const eas = config.extra?.eas ?? {};
  const build = eas.build ?? {};
  const experimental = build.experimental ?? {};
  const ios = experimental.ios ?? {};
  const extensions = (ios.appExtensions ?? []).filter((item) => item.targetName !== targetName);
  config.extra = {
    ...config.extra,
    eas: {
      ...eas,
      build: {
        ...build,
        experimental: {
          ...experimental,
          ios: {
            ...ios,
            appExtensions: [...extensions, { targetName, bundleIdentifier, entitlements }],
          },
        },
      },
    },
  };
  return config;
}

module.exports = function withPushNotificationService(config) {
  const mainBundleId = config.ios.bundleIdentifier;
  const bundleIdentifier = `${mainBundleId}.notifications`;
  const accessGroup = `$(AppIdentifierPrefix)${mainBundleId}`;
  const appGroup = `group.${mainBundleId}`;
  const entitlements = {
    "keychain-access-groups": [accessGroup],
    "com.apple.security.application-groups": [appGroup],
  };
  config = withExtensionConfig(config, bundleIdentifier, entitlements);
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.SupacodePushAccessGroup = accessGroup;
    cfg.modResults.SupacodePushAppGroup = appGroup;
    return cfg;
  });
  config = withEntitlementsPlist(config, (cfg) => {
    for (const [key, values] of Object.entries(entitlements)) {
      cfg.modResults[key] = [...new Set([...(cfg.modResults[key] ?? []), ...values])];
    }
    return cfg;
  });
  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      const target = path.join(cfg.modRequest.platformProjectRoot, targetName);
      fs.mkdirSync(target, { recursive: true });
      const sources = sourceFiles(cfg.modRequest.projectRoot);
      const names = new Set(sources.map((source) => source.name));
      for (const file of fs.readdirSync(target)) {
        if (file.endsWith(".swift") && !names.has(file)) fs.unlinkSync(path.join(target, file));
      }
      for (const source of sources) fs.copyFileSync(source.path, path.join(target, source.name));
      fs.writeFileSync(
        path.join(target, "Info.plist"),
        plist.build({
          CFBundleDevelopmentRegion: "$(DEVELOPMENT_LANGUAGE)",
          CFBundleDisplayName: config.name,
          CFBundleExecutable: "$(EXECUTABLE_NAME)",
          CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
          CFBundleInfoDictionaryVersion: "6.0",
          CFBundleName: "$(PRODUCT_NAME)",
          CFBundlePackageType: "XPC!",
          CFBundleShortVersionString: "$(MARKETING_VERSION)",
          CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
          SupacodePushAccessGroup: accessGroup,
          SupacodePushAppGroup: appGroup,
          NSExtension: {
            NSExtensionPointIdentifier: "com.apple.usernotifications.service",
            NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService",
          },
        }),
      );
      fs.writeFileSync(path.join(target, `${targetName}.entitlements`), plist.build(entitlements));
      return cfg;
    },
  ]);
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const objects = project.hash.project.objects;
    let entry = Object.entries(objects.PBXNativeTarget).find(
      ([id, target]) => !id.endsWith("_comment") && target.name?.replaceAll('"', "") === targetName,
    );
    if (!entry) {
      const target = project.addTarget(targetName, "app_extension", targetName, bundleIdentifier);
      project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
      project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
      for (const framework of [
        "CryptoKit.framework",
        "Security.framework",
        "UserNotifications.framework",
      ]) {
        project.addFramework(framework, { target: target.uuid });
      }
      entry = [target.uuid, target.pbxNativeTarget];
    }
    reconcileSources(project, entry[0], sourceFiles(cfg.modRequest.projectRoot));
    const configurations =
      objects.XCConfigurationList[entry[1].buildConfigurationList].buildConfigurations;
    for (const reference of configurations) {
      Object.assign(objects.XCBuildConfiguration[reference.value].buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: "YES",
        CODE_SIGN_STYLE: "Automatic",
        CODE_SIGN_ENTITLEMENTS: `"${targetName}/${targetName}.entitlements"`,
        INFOPLIST_FILE: `"${targetName}/Info.plist"`,
        GENERATE_INFOPLIST_FILE: "NO",
        IPHONEOS_DEPLOYMENT_TARGET: "18.0",
        PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}"`,
        PRODUCT_NAME: `"${targetName}"`,
        SWIFT_VERSION: "5.0",
        SKIP_INSTALL: "YES",
        TARGETED_DEVICE_FAMILY: '"1,2"',
        CURRENT_PROJECT_VERSION: `"${config.ios?.buildNumber ?? "1"}"`,
        MARKETING_VERSION: `"${config.version}"`,
      });
    }
    return cfg;
  });
};
