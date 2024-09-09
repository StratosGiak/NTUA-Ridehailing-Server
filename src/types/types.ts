import { RowDataPacket } from "mysql2";

export interface User extends RowDataPacket {
  id: string;
  full_name: string;
  given_name: string | null;
  picture: string | null;
  ratings_sum: number;
  ratings_count: number;
  cars: { [id: string]: Car };
  coords: { latitude: number; longitude: number };
}
export interface Driver extends User {
  car: Car;
  candidates: string[];
  passengers: string[];
}
export interface Passenger extends User {
  driver_id?: string;
}
export interface Car extends RowDataPacket {
  id: number;
  model: string;
  license: string;
  seats: number;
  color: number | null;
  picture: string | null;
}
export interface Credentials {
  id: string;
  full_name: string;
  given_name: string | null;
}
