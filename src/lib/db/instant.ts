import { customType } from "drizzle-orm/pg-core";
import { canonicalInstant, driverInstant } from "../instants";

export const instant = customType<{ data: string; driverData: string | Date }>({
  dataType: () => "timestamptz(3)",
  toDriver: canonicalInstant,
  fromDriver: driverInstant,
});
