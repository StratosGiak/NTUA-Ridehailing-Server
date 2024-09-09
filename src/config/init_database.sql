CREATE TABLE IF NOT EXISTS users (
  id varchar(12) NOT NULL,
  picture varchar(32) DEFAULT NULL,
  ratings_sum int NOT NULL DEFAULT 0,
  ratings_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cars (
  id int NOT NULL AUTO_INCREMENT,
  user_id varchar(12) NOT NULL,
  model varchar(45) NOT NULL,
  seats int NOT NULL,
  license varchar(8) NOT NULL,
  picture varchar(32) DEFAULT NULL,
  color int unsigned DEFAULT NULL,
  PRIMARY KEY (id),
  KEY user_id_idx (user_id),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;