"""Google Gemini AI client for fleet data analysis."""

from __future__ import annotations

import json
import os

from google import genai

SYSTEM_PROMPT = (
    "You are an expert fleet management analyst working with Geotab telematics data. "
    "Analyze the provided fleet data and give actionable insights. "
    "Focus on: efficiency trends, safety concerns, maintenance predictions, "
    "cost optimization, and route improvements. "
    "Be concise but thorough. Use specific numbers from the data. "
    "Structure your response with: Key Findings, Anomalies, and Recommendations."
)

ANALYSIS_PROMPTS = {
    "efficiency": "Analyze fuel efficiency, idle time, and driving patterns. Identify the least efficient vehicles and suggest improvements.",
    "safety": "Evaluate driver safety scores, harsh events, speeding incidents, and rule violations. Flag high-risk drivers or vehicles.",
    "maintenance": "Review fault codes, diagnostic data, and vehicle health. Predict upcoming maintenance needs and prioritize urgent issues.",
    "route_optimization": "Analyze trip routes, distances, durations, and stop patterns. Suggest route optimizations to reduce mileage and time.",
    "cost": "Calculate fleet operating costs from fuel, maintenance, and utilization data. Identify cost reduction opportunities.",
    "general": "Provide a comprehensive fleet health overview covering efficiency, safety, maintenance, and utilization.",
}


class GeminiClient:
    """Wrapper around the Google Gemini API for fleet analytics."""

    def __init__(self) -> None:
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable is required")
        self._client = genai.Client(api_key=api_key)
        self._model = "gemini-2.5-flash"

    def analyze_fleet(
        self,
        data: str | dict | list,
        analysis_type: str = "general",
        question: str = "",
    ) -> dict:
        """Send fleet data to Gemini for analysis.

        Args:
            data: Fleet data as JSON string, dict, or list
            analysis_type: One of efficiency|safety|maintenance|route_optimization|cost|general
            question: Optional specific question to answer about the data

        Returns:
            Dict with analysis text, model used, and analysis_type
        """
        if isinstance(data, (dict, list)):
            data_str = json.dumps(data, indent=2, default=str)
        else:
            data_str = str(data)

        type_prompt = ANALYSIS_PROMPTS.get(analysis_type, ANALYSIS_PROMPTS["general"])

        user_msg = f"{type_prompt}\n\n"
        if question:
            user_msg += f"Specific question: {question}\n\n"
        user_msg += f"Fleet data:\n```json\n{data_str}\n```"

        try:
            response = self._client.models.generate_content(
                model=self._model,
                contents=user_msg,
                config=genai.types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    temperature=0.3,
                    max_output_tokens=2048,
                ),
            )
            return {
                "analysis": response.text,
                "model": self._model,
                "analysis_type": analysis_type,
                "status": "success",
            }
        except Exception as e:
            return {
                "error": str(e),
                "model": self._model,
                "analysis_type": analysis_type,
                "status": "error",
            }

    def summarize_fleet(self, data: str | dict | list) -> dict:
        """Quick fleet health summary."""
        if isinstance(data, (dict, list)):
            data_str = json.dumps(data, indent=2, default=str)
        else:
            data_str = str(data)

        user_msg = (
            "Give a brief fleet health summary (3-5 bullet points) covering: "
            "vehicle count & utilization, top concerns, and one actionable recommendation.\n\n"
            f"Fleet data:\n```json\n{data_str}\n```"
        )

        try:
            response = self._client.models.generate_content(
                model=self._model,
                contents=user_msg,
                config=genai.types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    temperature=0.2,
                    max_output_tokens=512,
                ),
            )
            return {
                "summary": response.text,
                "model": self._model,
                "status": "success",
            }
        except Exception as e:
            return {
                "error": str(e),
                "model": self._model,
                "status": "error",
            }
