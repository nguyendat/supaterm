/* oxlint-disable unicorn/prefer-add-event-listener -- ELK's FakeWorker is a plain object whose dispatcher calls onmessage directly. */
import ElkConstructor, { type ELK, type ElkNode } from "elkjs/lib/elk.bundled.js";

interface FakeWorker {
  onmessage: ((answer: { data: { data?: ElkNode; error?: unknown } }) => void) | null;
  dispatcher: {
    saveDispatch(message: { data: { id: number; cmd: "layout"; graph: ElkNode } }): void;
  };
}

let fakeWorker: FakeWorker | undefined;

function createFakeWorker(): FakeWorker {
  const scope = globalThis as {
    document?: unknown;
    setTimeout: (callback: () => void, delay?: number) => unknown;
  };
  const setTimeout = scope.setTimeout;
  const registrations: Array<() => void> = [];
  // elkjs treats a scope with `self` but no `document` as a dedicated layout worker and
  // claims self.onmessage. A document stub selects its in-process FakeWorker instead.
  const stubDocument = scope.document === undefined;
  if (stubDocument) scope.document = {};
  // The constructor registers layout algorithms on setTimeout(0); running them before the
  // first layout keeps layout synchronous.
  scope.setTimeout = (callback, delay) => {
    if (delay !== 0) return setTimeout(callback, delay);
    registrations.push(callback);
    return 0;
  };
  let elk: ELK;
  try {
    elk = new ElkConstructor();
  } finally {
    scope.setTimeout = setTimeout;
    if (stubDocument) delete scope.document;
  }
  for (const register of registrations) register();
  return (elk as unknown as { worker: { worker: FakeWorker } }).worker.worker;
}

export function elkLayoutSync(graph: ElkNode): ElkNode {
  const worker = (fakeWorker ??= createFakeWorker());
  let result: ElkNode | undefined;
  let error: unknown;
  const onmessage = worker.onmessage;
  worker.onmessage = (answer) => {
    if (answer.data.error) error = answer.data.error;
    else result = answer.data.data;
  };
  try {
    worker.dispatcher.saveDispatch({ data: { id: 0, cmd: "layout", graph } });
  } finally {
    worker.onmessage = onmessage;
  }
  if (error) throw error;
  if (!result) throw new Error("ELK layout did not complete synchronously");
  return result;
}
