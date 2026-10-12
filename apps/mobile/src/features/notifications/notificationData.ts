import { PushEnrollmentData, PushNotificationData } from "@supacode/contracts/push";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeNotification = Schema.decodeUnknownOption(
  Schema.Struct({ supacode: PushNotificationData }),
);
const decodeEnrollment = Schema.decodeUnknownOption(
  Schema.Struct({ supacode: PushEnrollmentData }),
);

export function notificationData(value: unknown) {
  return Option.getOrNull(Option.map(decodeNotification(value), (data) => data.supacode));
}

export function enrollmentData(value: unknown) {
  return Option.getOrNull(Option.map(decodeEnrollment(value), (data) => data.supacode));
}

export function sameNotification(
  left: typeof PushNotificationData.Type | null,
  right: typeof PushNotificationData.Type | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.recipientId === right.recipientId &&
      left.generation === right.generation &&
      left.notificationId === right.notificationId)
  );
}
