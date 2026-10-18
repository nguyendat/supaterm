export interface ClassDiagram {
  classes: ClassNode[];
  relationships: ClassRelationship[];
  namespaces: ClassNamespace[];
}
export interface ClassNode {
  id: string;
  label: string;
  annotation?: string | undefined;
  attributes: ClassMember[];
  methods: ClassMember[];
}
export interface ClassMember {
  visibility: "+" | "-" | "#" | "~" | "";
  name: string;
  type?: string | undefined;
  isStatic?: boolean;
  isAbstract?: boolean;
  isMethod?: boolean;
  params?: string | undefined;
}
export type RelationshipType =
  | "inheritance"
  | "composition"
  | "aggregation"
  | "association"
  | "dependency"
  | "realization";
export interface ClassRelationship {
  from: string;
  to: string;
  type: RelationshipType;
  markerAt: "from" | "to";
  label?: string | undefined;
  fromCardinality?: string | undefined;
  toCardinality?: string | undefined;
}
export interface ClassNamespace {
  name: string;
  classIds: string[];
}
export interface PositionedClassDiagram {
  width: number;
  height: number;
  classes: PositionedClassNode[];
  relationships: PositionedClassRelationship[];
}
export interface PositionedClassNode {
  id: string;
  label: string;
  annotation?: string | undefined;
  attributes: ClassMember[];
  methods: ClassMember[];
  x: number;
  y: number;
  width: number;
  height: number;
  headerHeight: number;
  attrHeight: number;
  methodHeight: number;
}
export interface PositionedClassRelationship {
  from: string;
  to: string;
  type: RelationshipType;
  markerAt: "from" | "to";
  label?: string | undefined;
  fromCardinality?: string | undefined;
  toCardinality?: string | undefined;
  points: Array<{
    x: number;
    y: number;
  }>;
  labelPosition?:
    | {
        x: number;
        y: number;
      }
    | undefined;
}
