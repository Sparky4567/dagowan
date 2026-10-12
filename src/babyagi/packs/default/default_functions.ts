import type { Functionz } from "../../core/framework";

export function loadDefaultFunctions(framework: Functionz): void {
  // World function
  framework.registerFunction(
    function world() {
      return "world";
    },
    {
      name: "world",
      description: "Returns the string 'world'",
      metadata: { category: "utility" }
    }
  );

  // Hello world with dependency on 'world'
  framework.registerFunction(
    async function hello_world() {
      const w = await framework.executeFunction("world");
      return `Hello ${w}!`;
    },
    {
      name: "hello_world",
      dependencies: ["world"],
      description: "Returns 'Hello world!' by calling the 'world' function",
      metadata: { category: "utility" }
    }
  );

  // Math: Circle Area
  framework.registerFunction(
    function circle_area(radius: number) {
      if (typeof radius !== "number" || radius < 0) {
        throw new Error("Radius must be a positive number");
      }
      return Math.PI * radius * radius;
    },
    {
      name: "circle_area",
      description: "Calculates the area of a circle given its radius",
      metadata: { category: "math", formula: "pi * r^2" }
    }
  );

  // Math: Cylinder Volume (depends on circle_area)
  framework.registerFunction(
    async function cylinder_volume(radius: number, height: number) {
      const baseArea = await framework.executeFunction("circle_area", radius);
      return baseArea * height;
    },
    {
      name: "cylinder_volume",
      dependencies: ["circle_area"],
      description: "Calculates the volume of a cylinder using circle_area",
      metadata: { category: "math", formula: "circle_area(r) * h" }
    }
  );

  // String: Format Text
  framework.registerFunction(
    function format_text(text: string, style: "upper" | "lower" | "title" | "slug") {
      if (!text) return "";
      switch (style) {
        case "upper":
          return text.toUpperCase();
        case "lower":
          return text.toLowerCase();
        case "title":
          return text.replace(/\b\w/g, (c) => c.toUpperCase());
        case "slug":
          return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        default:
          return text;
      }
    },
    {
      name: "format_text",
      description: "Formats a string into uppercase, lowercase, titlecase, or URL slug",
      metadata: { category: "string" }
    }
  );

  // Utility: Current Timestamp
  framework.registerFunction(
    function get_current_time() {
      return new Date().toISOString();
    },
    {
      name: "get_current_time",
      description: "Returns the current ISO date and time",
      metadata: { category: "utility" }
    }
  );
}
