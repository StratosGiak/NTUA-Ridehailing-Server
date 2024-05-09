import mysql, { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2";
import { Car, User } from "./types/types.js";

const pool = mysql
  .createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PWD,
    database: process.env.DB_DBNAME,
  })
  .promise();

await pool.execute(`
CREATE TABLE IF NOT EXISTS \`users\` (
  \`id\` varchar(45) NOT NULL,
  \`picture\` varchar(45) DEFAULT NULL,
  \`ratings_sum\` int NOT NULL DEFAULT '0',
  \`ratings_count\` int NOT NULL DEFAULT '0',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
`);

await pool.execute(`
CREATE TABLE IF NOT EXISTS \`cars\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`user_id\` varchar(45) NOT NULL,
  \`model\` varchar(45) NOT NULL,
  \`seats\` int NOT NULL,
  \`license\` varchar(45) NOT NULL,
  \`picture\` varchar(45) DEFAULT NULL,
  \`color\` int unsigned DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`user_id_idx\` (\`user_id\`),
  CONSTRAINT \`user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=91 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
`);

export async function getAllUsers(): Promise<{ [id: string]: User }> {
  const [users] = await pool.execute<User[]>("SELECT * FROM users");
  const [cars] = await pool.execute<Car[]>("SELECT * FROM cars");
  const result = users.map((user, _) => {
    user.cars = cars
      .filter((car) => car.user_id == user.id)
      .reduce<{ [id: string]: Car }>((map, car) => {
        map[car.id] = car;
        delete car.user_id;
        return map;
      }, {});
    return user;
  });
  return result.reduce<{ [id: string]: User }>((map, user) => {
    map[user.id] = user;
    return map;
  }, {});
}

export async function getUser(user_id: string): Promise<User | undefined> {
  const [user] = await pool.execute<User[]>(
    `SELECT * FROM users WHERE id = ?`,
    [user_id]
  );
  if (!user[0]) return;
  const [cars] = await pool.execute<Car[]>(
    `SELECT * FROM cars WHERE user_id = ?`,
    [user_id]
  );
  user[0].cars = cars.reduce<{ [id: string]: Car }>((map, car) => {
    delete car.user_id;
    map[car.id] = car;
    return map;
  }, {});
  return user[0];
}

export async function getCar(id: number): Promise<Car | undefined> {
  const [car] = await pool.execute<Car[]>(`SELECT * FROM cars WHERE id = ?`, [
    id,
  ]);
  return car[0];
}

export async function createUser(user_id: string): Promise<User | undefined> {
  const [result, fields] = await pool.execute(
    `INSERT INTO users (id) VALUES (?)`,
    [user_id]
  );
  return getUser(user_id);
}

export async function createCar(
  user_id: string,
  car: Car
): Promise<Car | undefined> {
  const [result, fields] = await pool.execute<ResultSetHeader>(
    `INSERT INTO cars (user_id, model, seats, license, picture, color) VALUES (?, ?, ?, ?, ?, ?)`,
    [user_id, car.model, car.seats, car.license, car.picture, car.color]
  );
  return getCar(result.insertId);
}

export async function updateUserPicture(
  user_id: string,
  picture: string | null
): Promise<User | undefined> {
  const [result] = await pool.execute(
    `UPDATE users SET picture = ? WHERE (id = ?)`,
    [picture, user_id]
  );
  return getUser(user_id);
}

export async function updateUserRating(
  user_id: string,
  ratings_sum: number,
  ratings_count: number
): Promise<void> {
  const [result] = await pool.execute(
    `UPDATE users SET ratings_sum = ?, ratings_count = ? WHERE (id = ?)`,
    [ratings_sum, ratings_count, user_id]
  );
}

export async function updateUserCar(
  user_id: string,
  car: Car
): Promise<Car | undefined> {
  const [result] = await pool.execute(
    `UPDATE cars SET model = ?, seats = ?, license = ?, picture = ?, color = ? WHERE (user_id = ?) & (id = ?)`,
    [car.model, car.seats, car.license, car.picture, car.color, user_id, car.id]
  );
  return getCar(car.id);
}

export async function removeUserCar(
  user_id: string,
  car_id: number
): Promise<void> {
  const [result, fields] = await pool.execute(
    `DELETE FROM cars WHERE (user_id = ?) & (id = ?)`,
    [user_id, car_id]
  );
}

export async function removeUser(user_id: string): Promise<void> {
  await pool.execute(`DELETE FROM users WHERE id = ?`, [user_id]);
  await pool.execute(`DELETE FROM cars WHERE user_id = ?`, [user_id]);
}
