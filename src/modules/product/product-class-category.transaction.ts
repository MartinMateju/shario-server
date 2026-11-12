import mongoose, { type ClientSession } from "mongoose";

export const withProductClassCategoryTransaction = <Result>(
  operation: (session: ClientSession) => Promise<Result>,
): Promise<Result> => mongoose.connection.transaction(operation);
