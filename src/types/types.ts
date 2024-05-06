export interface User {
  id: string;
  name: string;
  given_name: string | null;
  picture?: string | null;
  ratings_sum: number;
  ratings_count: number;
  cars?: Car[];
  coords: [number, number];
}
export interface Driver extends User {
  car: Car;
  passengers: string[];
}
export interface Passenger extends User {
  driver_id?: string;
}
export interface Car {
  model: string;
  license: string;
  seats: number;
  color?: number | null;
  picture?: string | null;
}
export interface Credentials {
  id: string;
  name: string;
  given_name: string | null;
}

export {};
