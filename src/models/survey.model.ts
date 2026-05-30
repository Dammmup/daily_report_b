import mongoose, { Schema } from "mongoose";
import { strengthProfileSchema } from "./shared.js";

const surveySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    answers: {
      traits: { type: [String], default: [] },
      skills: { type: String, required: true },
      experience: { type: String, required: true },
      learningStyle: { type: String, required: true },
      goal: { type: String, required: true }
    },
    analysis: { type: strengthProfileSchema, required: true }
  },
  { timestamps: true }
);

export const SurveyModel = mongoose.model("Survey", surveySchema);
