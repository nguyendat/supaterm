let api: Promise<() => boolean> | undefined;

export async function hasInputMonitoringPermission(): Promise<boolean> {
  api ??= import("ffi-rs").then(({ DataType, open, load }) => {
    const library = "supacode-micro-iokit";
    open({ library, path: "/System/Library/Frameworks/IOKit.framework/IOKit" });
    return () =>
      load({
        library,
        funcName: "IOHIDCheckAccess",
        retType: DataType.I32,
        paramsType: [DataType.I32],
        paramsValue: [1],
      }) === 0;
  });
  return (await api)();
}
